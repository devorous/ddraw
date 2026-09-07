<script>
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { appState } from '../../state.svelte.js';
  import { isTauriDesktop } from '../../platform/desktop.js';
  import { isMobile } from '../../platform/mobile.js';
  import { isChatPopoutOpen } from '../../platform/chatPopoutBridge.js';
  import { playSfx } from '../../utils/sfx.js';
  import { DEFAULT_SFX_PREFERENCES, saveAppPreferences } from '../../config/AppPreferences.js';
  import WindowTitleBar from './WindowTitleBar.svelte';

  const CHAT_POSITION_STORAGE_KEY = 'topdraw-chat-position';
  const COMPOSER_EMOJIS = [
    '\u{1F600}', '\u{1F603}', '\u{1F604}', '\u{1F601}', '\u{1F606}', '\u{1F605}',
    '\u{1F923}', '\u{1F602}', '\u{1F642}', '\u{1F643}', '\u{1F609}', '\u{1F60A}',
    '\u{1F60D}', '\u{1F970}', '\u{1F618}', '\u{1F60E}', '\u{1F929}', '\u{1F60F}',
    '\u{1F62D}', '\u{1F97A}', '\u{1F62E}', '\u{1F631}', '\u{1F92F}', '\u{1F525}',
    '\u2728', '\u{1F4AF}', '\u{1F389}', '\u{1F44F}', '\u{1F44D}', '\u{1F44E}',
    '\u{1F64C}', '\u{1F64F}', '\u{1F91D}', '\u2764\uFE0F', '\u{1F49C}',
    '\u{1F496}', '\u{1F4A5}', '\u{1F4A8}', '\u{1F4A6}', '\u{1F440}', '\u{1F440}',
    '\u{1F914}', '\u{1F928}', '\u{1F910}', '\u{1F92D}', '\u{1F92B}', '\u{1F4A9}',
    '\u{1F921}', '\u{1F975}', '\u{1F976}', '\u{1F383}', '\u{1F921}', '\u{1F47D}',
    '\u{1F47B}', '\u{1F480}', '\u{1F916}', '\u{1F47A}', '\u{1F47F}', '\u{1F32E}',
    '\u{1F34C}', '\u{1F355}', '\u{1F354}', '\u{1F36A}', '\u{1F37F}', '\u{1F3A8}',
    '\u{1F3AE}', '\u{1F3C6}', '\u{1F3C1}', '\u{1F680}', '\u{1F4A1}', '\u{1F44C}'
  ];
  const REACTION_EMOJIS = [
    '\u{1F44D}', '\u2764\uFE0F', '\u{1F525}', '\u{1F602}', '\u{1F62E}', '\u{1F3A8}',
    '\u{1F44F}', '\u2728', '\u{1F389}', '\u{1F60D}', '\u{1F914}', '\u{1F44E}',
    '\u{1F4AF}', '\u{1F4A9}', '\u{1F923}', '\u{1F97A}', '\u{1F62D}', '\u{1F440}',
    '\u{1F64C}', '\u{1F64F}', '\u{1F92F}', '\u{1F47D}', '\u{1F480}', '\u{1F32E}'
  ];
  const CHAT_UPLOAD_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif'
  ]);
  const MENTION_CANDIDATE_RE = /(^|\s)@([A-Za-z0-9_-]*)$/;
  const MENTION_TOKEN_RE = /(^|\s)@([A-Za-z0-9_-]{1,32})\b/g;
  const CHAT_PIN_STORAGE_KEY = 'topdraw-chat-pinned';
  // The name gutter is a fixed-width CSS grid track (--chat-name-col below) so
  // every message body lines up on the same x. Truncating the label ourselves
  // — rather than leaning on CSS text-overflow against a right-aligned box —
  // keeps the "…" visible: text-overflow only clips at an inline's end edge,
  // which for right-aligned overflow is the wrong side, so long names were
  // disappearing behind the box edge with no ellipsis at all.
  const CHAT_NAME_DISPLAY_MAX = 14;
  const CHAT_NAME_DISPLAY_MAX_MOBILE = 10;
  /* Peek stack: how long the last lines linger on the canvas after the room
     goes quiet, and how much slack the pointer gets before the window folds
     back down (so clipping a corner doesn't slam it shut mid-read). */
  const PEEK_QUIET_MS = 20000;
  const PEEK_GRACE_MS = 600;
  const PEEK_FORCE_OPEN_MS = 7000;
  const CHAT_TOOL_ICONS = {
    brush: '/images/brush-icon.svg',
    flowPen: '/images/brush-icon.svg',
    ink: '/images/brush-icon.svg',
    pixel: '/images/brush-icon.svg',
    imageBrush: '/images/brush-icon.svg',
    line: '/images/line-icon.svg',
    rectangle: '/images/rectangle-icon.svg',
    circle: '/images/circle-icon.svg',
    text: '/images/text-icon.svg',
    erase: '/images/eraser-icon.svg',
    blur: '/images/blend-icon.svg',
    circleBlur: '/images/circle-blur-icon.svg',
    glitchBlur: '/images/glitch-icon.svg',
    fill: '/images/fillbucket-icon.svg',
    select: '/images/select-icon.svg',
    pattern: '/images/pattern-icon.svg',
    inkdropper: '/images/inkdropper-icon.svg',
    pan: '/images/move-icon.svg',
    zoom: '/images/magnifying-glass.svg',
    rotate: '/images/rotate-icon.svg'
  };
  const INACTIVE_TOOL_ICON = '/images/zzz-icon.svg';
  const MAX_CHAT_UPLOAD_BYTES = Math.floor(4.5 * 1024 * 1024);
  const MAX_CHAT_UPLOAD_DIMENSION = 4096;
  const MAX_CHAT_UPLOAD_PIXELS = 8_388_608;
  const GALLERY_LINK_HOSTS = new Set(['ddraw.ca', 'www.ddraw.ca']);

  let {
    onSend = null,
    onStaffSend = null,
    onStaffSendImage = null,
    onDM = null,
    onSendImage = null,
    onReact = null,
    onDeleteMessage = null,
    onPopout = null,
    isPopout = false
  } = $props();

  let activeView = $state('all');
  let messageInput = $state('');
  // Compact mode was removed — full is the only non-mini layout now, and mini
  // already takes over automatically on small windows. Kept as a named
  // constant (rather than inlining 'full' everywhere) because several
  // functions below key stored position/size by mode name.
  const chatMode = 'full';
  let messages = $state({
    all: [],
    staff: [],
    dms: new Map()
  });
  let dmMeta = $state(new Map());
  let isDragging = $state(false);
  let hudAwake = $state(false);
  let hudWakeTimer = null;
  let hudOpen = $state(false);
  let hudPinned = $state(false);
  let peekQuiet = $state(true);
  let peekQuietTimer = null;
  let hudCollapseTimer = null;
  let chatEl = $state(null);
  let publicMessagesEl = $state(null);
  let dmMessagesEl = $state(null);
  let fileInputEl = $state(null);
  let composerInputEl = $state(null);
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let isDropTarget = $state(false);
  let dropDepth = 0;
  let showEmojiPicker = $state(false);
  let composerImage = $state(null);
  let mentionSuggestion = $state(null); // { username, start, end }
  let expandedImage = $state(null);
  let galleryPreviewCache = $state(new Map());
  let pendingGalleryPreviews = new Set();
  let chatPinnedToBottom = $state({
    all: true,
    staff: true,
    dm: true
  });

  let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

  let visible = $derived(isPopout || appState.chatVisible);
  let isSmallScreen = $derived(windowWidth < 768);
  // Small-desktop windows fall back to mini; mobile has its own full-size
  // layout (html[data-mobile] geometry + hidden tool rail), so mini's
  // shrunk controls would only shrink touch targets there.
  let effectiveChatMode = $derived(isPopout ? 'full' : isSmallScreen && !isMobile() ? 'mini' : chatMode);
  let hideRoomNotifications = $derived(!!appState.currentRoomData?.hideChatNotifications);
  // Collapsed is the resting state for the in-app HUD; the popout is a real
  // window and the pin opts out of collapsing altogether.
  // Mobile has no hover to summon it back and its own centred geometry, so
  // peek stays a pointer-device behaviour.
  let isPeekCollapsed = $derived(!isPopout && !isMobile() && !hudPinned && !hudOpen);
  let isDesktopClient = $state(false);
  let desktopWindowApi = null;
  let desktopWindowState = $state({
    maximized: false,
    fullscreen: false
  });
  let lastComposerFocusKey = '';

  $effect(() => {
    if (hideRoomNotifications && toasts.length > 0) {
      toasts = [];
    }
  });

  // Mobile: the chat takes the whole screen's attention — hide the tool
  // rail while it's open (css keys off this class) so the window can
  // center full-width.
  $effect(() => {
    if (isPopout || !isMobile()) return;
    document.documentElement.classList.toggle('chat-open-mobile', !!appState.chatVisible);
    return () => document.documentElement.classList.remove('chat-open-mobile');
  });
  let recipient = $derived.by(() => {
    const selected = appState.dmRecipient;
    if (!selected) return null;
    return getChatUser(selected.id) || selected;
  });

  let activeThreads = $derived.by(() => {
    const ids = new Set(messages.dms.keys());
    if (recipient?.id !== undefined && recipient?.id !== null) ids.add(recipient.id);

    return [...ids]
      .map((userId) => {
        const threadMessages = messages.dms.get(userId) || [];
        const lastMessage = threadMessages[threadMessages.length - 1];
        const user = getChatUser(userId);

        return { id: userId, user, lastMessage };
      })
      .sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
  });

  let directoryUsers = $derived.by(() => {
    return [...appState.users.values()].sort((a, b) => a.username.localeCompare(b.username));
  });

  let activeDMMessages = $derived.by(() => {
    if (!recipient?.id && recipient?.id !== 0) return [];
    return messages.dms.get(recipient.id) || [];
  });

  let groupedPublicMessages = $derived.by(() => {
    return groupChannelMessages(messages.all);
  });

  let groupedStaffMessages = $derived.by(() => {
    return groupChannelMessages(messages.staff);
  });

  let canAccessStaff = $derived(appState.selfRole >= 4);

  function groupChannelMessages(channelMessages) {
    return channelMessages.map((msg, index) => {
      const previous = channelMessages[index - 1];
      const next = channelMessages[index + 1];
      const groupedWithPrevious = Boolean(
        previous &&
        isChatMessage(previous) &&
        isChatMessage(msg) &&
        Number(previous.userId) === Number(msg.userId) &&
        msg.timestamp - previous.timestamp < 60_000
      );
      const groupedWithNext = Boolean(
        next &&
        isChatMessage(next) &&
        isChatMessage(msg) &&
        Number(next.userId) === Number(msg.userId) &&
        next.timestamp - msg.timestamp < 60_000
      );

      return { ...msg, groupedWithPrevious, groupedWithNext };
    });
  }

  let toasts = $state([]);
  let toastIdCounter = 0;

  function loadChatPositions() {
    try {
      const raw = localStorage.getItem(CHAT_POSITION_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function persistChatPositions(nextPositions) {
    try {
      localStorage.setItem(CHAT_POSITION_STORAGE_KEY, JSON.stringify(nextPositions));
    } catch {
      // Ignore storage failures.
    }
  }

  function createMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function isChatMessage(message) {
    return message?.type === 'message' || message?.type === 'image';
  }

  function rankedComposerEmojis() {
    return [...new Set([...COMPOSER_EMOJIS, ...REACTION_EMOJIS])];
  }

  function hoverReactionEmojis(limit = 6) {
    return [...new Set(REACTION_EMOJIS)].slice(0, limit);
  }

  function selectableHoverReactionEmojis(message, limit = 5) {
    const existing = new Set((message.reactions || []).map((reaction) => reaction.emoji));
    return hoverReactionEmojis(limit + existing.size)
      .filter((emoji) => !existing.has(emoji))
      .slice(0, limit);
  }

  function createBaseMessage({
    id = createMessageId(),
    type = 'message',
    text = '',
    imageData = '',
    username = '',
    color = '#8ba3c7',
    timestamp = Date.now(),
    userId = null,
    fromSelf = false,
    read = false,
    threadUserId = null,
    userRole = 0
  }) {
    return {
      id,
      type,
      text,
      imageData,
      username,
      color,
      timestamp,
      userId,
      fromSelf,
      read,
      threadUserId,
      userRole,
      reactions: []
    };
  }

  function cloneMessage(message) {
    return {
      ...message,
      reactions: (message.reactions || []).map((reaction) => ({
        ...reaction,
        users: [...(reaction.users || [])]
      }))
    };
  }

  function show() {
    appState.chatVisible = true;
    appState.chatUnreadCount = 0;
  }

  function hide() {
    if (isPopout) {
      window.close();
      return;
    }

    appState.chatVisible = false;
  }

  async function closeChatWindow() {
    if (expandedImage) {
      closeImageViewer();
      return;
    }

    if (!isPopout) {
      hide();
      return;
    }

    if (desktopWindowApi) {
      await desktopWindowApi.close();
      return;
    }

    window.close();
  }

  function popoutChat() {
    onPopout?.();
  }

  async function syncDesktopWindowState() {
    if (!desktopWindowApi) return;

    desktopWindowState = {
      maximized: await desktopWindowApi.isMaximized(),
      fullscreen: await desktopWindowApi.isFullscreen()
    };
  }

  async function minimizeDesktopWindow() {
    if (!desktopWindowApi) return;
    await desktopWindowApi.minimize();
  }

  async function toggleMaximizeDesktopWindow() {
    if (!desktopWindowApi) return;
    await desktopWindowApi.toggleMaximize();
    await syncDesktopWindowState();
  }

  async function toggleFullscreenDesktopWindow() {
    if (!desktopWindowApi) return;
    const nextFullscreen = !(await desktopWindowApi.isFullscreen());
    await desktopWindowApi.setFullscreen(nextFullscreen);
    await syncDesktopWindowState();
  }

  let lastNonZeroSfxVolume = $state(initialNonZeroSfxVolume());

  function initialNonZeroSfxVolume() {
    const saved = Number(appState.appPreferences?.general?.sfx?.volume);
    return Number.isFinite(saved) && saved > 0 ? Math.min(1, saved) : DEFAULT_SFX_PREFERENCES.volume;
  }

  function getSfxPrefs() {
    return {
      ...DEFAULT_SFX_PREFERENCES,
      ...(appState.appPreferences?.general?.sfx ?? {})
    };
  }

  function getSfxVolume() {
    const value = Number(getSfxPrefs().volume);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_SFX_PREFERENCES.volume;
  }

  function persistSfxVolume(volume) {
    const clamped = Math.min(1, Math.max(0, Number(volume) || 0));
    const nextPreferences = {
      ...(appState.appPreferences ?? {}),
      general: {
        ...(appState.appPreferences?.general ?? {}),
        sfx: {
          ...getSfxPrefs(),
          volume: clamped
        }
      }
    };
    appState.appPreferences = saveAppPreferences(nextPreferences);
  }

  function handleSfxSliderInput(event) {
    const value = Number(event.currentTarget.value);
    if (!Number.isFinite(value)) return;
    if (value > 0) lastNonZeroSfxVolume = value;
    persistSfxVolume(value);
  }

  function toggleSfxMute() {
    const current = getSfxVolume();
    if (current > 0) {
      lastNonZeroSfxVolume = current;
      persistSfxVolume(0);
    } else {
      const restore = lastNonZeroSfxVolume > 0 ? lastNonZeroSfxVolume : DEFAULT_SFX_PREFERENCES.volume;
      persistSfxVolume(restore);
    }
  }

  function showPublic() {
    activeView = 'all';
    appState.dmRecipient = null;
  }

  function showDirectory() {
    activeView = 'directory';
    appState.dmRecipient = null;
  }

  function showStaff() {
    if (!canAccessStaff) return;
    activeView = 'staff';
    appState.dmRecipient = null;
  }

  function selectDMRecipient(user) {
    rememberDMUser(user);
    appState.dmRecipient = user;
    activeView = 'dm';
    markThreadRead(user.id);
  }

  function openThreadById(userId) {
    const user = getChatUser(userId);
    if (user) {
      selectDMRecipient(user);
      return;
    }

    const cachedUser = dmMeta.get(userId);
    if (cachedUser) {
      selectDMRecipient(cachedUser);
    }
  }

  function handleSend() {
    const msg = messageInput.trim();
    const recipientId = activeView === 'dm' && recipient ? recipient.id : null;
    const pendingImage = composerImage;
    const hasImage = !!pendingImage;

    if (!msg && !hasImage) return;

    messageInput = '';
    composerImage = null;
    showEmojiPicker = false;

    if (msg) {
      if (activeView === 'all' && onSend) onSend(msg);
      else if (activeView === 'staff' && onStaffSend) onStaffSend(msg);
      else if (recipientId !== null && onDM) onDM(msg, recipientId);
    }

    if (hasImage) {
      if (activeView === 'staff' && onStaffSendImage) {
        onStaffSendImage(pendingImage.dataUrl);
      } else if (onSendImage) {
        onSendImage(pendingImage.dataUrl, recipientId);
      }
    }
  }

  function handleKeydown(event) {
    if ((event.key === 'Tab' || event.key === 'Enter') && mentionSuggestion) {
      event.preventDefault();
      event.stopPropagation();
      void completeMentionSuggestion();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  function getSelfMentionAliases() {
    const aliases = new Set();
    const pushAlias = (value) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized) aliases.add(normalized);
    };

    pushAlias(window.app?.self?.username);
    pushAlias(appState.username);
    pushAlias(appState.self?.username);
    pushAlias(appState.self?.registeredName);

    return aliases;
  }

  function messageMentionsSelf(text) {
    if (!text) return false;

    const aliases = getSelfMentionAliases();
    if (aliases.size === 0) return false;

    const content = String(text);
    let match;
    MENTION_TOKEN_RE.lastIndex = 0;
    while ((match = MENTION_TOKEN_RE.exec(content)) !== null) {
      const handle = String(match[2] || '').trim().toLowerCase();
      if (aliases.has(handle)) {
        return true;
      }
    }
    return false;
  }

  function playMentionPing() {
    playSfx('chat');
    setTimeout(() => playSfx('chat'), 200);
  }

  function buildMentionCandidates() {
    const candidates = new Map();
    const addCandidate = (username) => {
      const trimmed = String(username || '').trim();
      if (!trimmed) return;
      const key = trimmed.toLowerCase();
      if (!candidates.has(key)) {
        candidates.set(key, trimmed);
      }
    };

    for (const user of appState.users.values()) {
      addCandidate(user?.username);
      addCandidate(user?.registeredName);
      addCandidate(user?.name);
    }
    addCandidate(window.app?.self?.username);
    addCandidate(appState.username);
    addCandidate(appState.self?.username);
    addCandidate(appState.self?.registeredName);

    return [...candidates.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  function syncMentionSuggestion() {
    if (!composerInputEl || activeView === 'directory') {
      mentionSuggestion = null;
      return;
    }

    const selectionStart = composerInputEl.selectionStart ?? 0;
    const selectionEnd = composerInputEl.selectionEnd ?? selectionStart;
    if (selectionStart !== selectionEnd) {
      mentionSuggestion = null;
      return;
    }

    const beforeCaret = messageInput.slice(0, selectionStart);
    const match = beforeCaret.match(MENTION_CANDIDATE_RE);
    if (!match) {
      mentionSuggestion = null;
      return;
    }

    const query = String(match[2] || '');
    if (!query) {
      mentionSuggestion = null;
      return;
    }

    const loweredQuery = query.toLowerCase();
    const candidates = buildMentionCandidates();
    const selected = candidates.find((name) => name.toLowerCase().startsWith(loweredQuery));
    if (!selected) {
      mentionSuggestion = null;
      return;
    }

    mentionSuggestion = {
      username: selected,
      start: selectionStart - query.length - 1,
      end: selectionStart
    };
  }

  async function completeMentionSuggestion() {
    if (!mentionSuggestion) return;

    const selectionStart = composerInputEl?.selectionStart ?? mentionSuggestion.end;
    const selectionEnd = composerInputEl?.selectionEnd ?? selectionStart;
    const replacement = `@${mentionSuggestion.username} `;
    const nextValue = `${messageInput.slice(0, mentionSuggestion.start)}${replacement}${messageInput.slice(selectionEnd)}`;
    const nextCaret = mentionSuggestion.start + replacement.length;

    messageInput = nextValue;
    mentionSuggestion = null;

    await tick();
    if (composerInputEl) {
      composerInputEl.focus({ preventScroll: true });
      composerInputEl.setSelectionRange(nextCaret, nextCaret);
    }
  }

  async function focusComposer() {
    if (!visible || activeView === 'directory') return;
    await tick();
    composerInputEl?.focus({ preventScroll: true });
  }

  function findUserByMentionHandle(handle) {
    const target = String(handle || '').trim().toLowerCase();
    if (!target) return null;

    const selfUser = window.app?.self;
    const selfNames = [
      selfUser?.username,
      appState.username,
      appState.self?.username,
      appState.self?.registeredName
    ];
    if (selfNames.some((name) => String(name || '').trim().toLowerCase() === target)) {
      return {
        id: appState.sessionIndex,
        role: appState.selfRole || selfUser?.role || 0
      };
    }

    for (const user of appState.users.values()) {
      const aliases = [user?.username, user?.registeredName, user?.name];
      if (aliases.some((name) => String(name || '').trim().toLowerCase() === target)) {
        return {
          id: user?.id ?? user?.sessionIndex ?? null,
          role: user?.role || 0
        };
      }
    }

    return null;
  }

  function applyMentionStylingToHtml(html) {
    const parts = String(html || '').split(/(<[^>]+>)/g);
    return parts
      .map((part) => {
        if (part.startsWith('<')) return part;
        return part.replace(/(^|\s)@([A-Za-z0-9_-]{1,32})\b/g, (_, prefix, handle) => {
          const matchedUser = findUserByMentionHandle(handle);
          const roleClass = getRoleClass(matchedUser?.id ?? null, matchedUser?.role ?? 0);
          return `${prefix}<span class="message-mention ${roleClass}">@${handle}</span>`;
        });
      })
      .join('');
  }

  function linkify(text) {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const withLinks = escaped.replace(
      /https?:\/\/[^\s<>"]+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`
    );
    const withMentions = applyMentionStylingToHtml(withLinks);
    return withMentions.replace(
      /(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/gu,
      '<span class="chat-inline-emoji">$1</span>'
    );
  }

  function extractGalleryLinks(text) {
    if (!text) return [];
    const seen = new Set();
    const links = [];
    const matches = String(text).match(/https?:\/\/[^\s<>"]+/g) || [];

    for (const rawUrl of matches) {
      try {
        const url = new URL(rawUrl);
        const id = url.pathname.match(/^\/gallery\/([a-f0-9]{24})\/?$/i)?.[1];
        if (!id || !GALLERY_LINK_HOSTS.has(url.hostname.toLowerCase()) || seen.has(id)) continue;
        seen.add(id);
        links.push({ id, url: url.toString() });
      } catch {
        // Ignore malformed pasted URLs.
      }
    }

    return links;
  }

  function getGalleryPreview(link) {
    if (!link?.id) return null;
    const cached = galleryPreviewCache.get(link.id);
    if (cached || pendingGalleryPreviews.has(link.id)) return cached || null;

    pendingGalleryPreviews.add(link.id);
    fetch(`/api/gallery/${encodeURIComponent(link.id)}`)
      .then((res) => {
        if (res.ok) return res.json();
        return fetch(`/api/gallery-item?id=${encodeURIComponent(link.id)}`)
          .then((fallbackRes) => (fallbackRes.ok ? fallbackRes.json() : null));
      })
      .then((item) => {
        if (!item?.id) {
          galleryPreviewCache = new Map(galleryPreviewCache).set(link.id, { missing: true });
          return;
        }

        galleryPreviewCache = new Map(galleryPreviewCache).set(link.id, {
          id: item.id,
          title: item.title || 'Gallery image',
          author: item.author || 'DDraw artist',
          thumbUrl: item.thumbUrl || item.url,
          url: link.url,
          nsfw: Array.isArray(item.tags) && item.tags.includes('nsfw')
        });
      })
      .catch(() => {
        galleryPreviewCache = new Map(galleryPreviewCache).set(link.id, { missing: true });
      })
      .finally(() => {
        pendingGalleryPreviews.delete(link.id);
      });

    return null;
  }

  async function openChatUrl(href) {
    if (!href) return;

    if (isTauriDesktop()) {
      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(href);
        return;
      } catch (error) {
        console.error('[Chat] Failed to open link via Tauri shell:', error);
      }
    }

    window.open(href, '_blank', 'noopener,noreferrer');
  }

  function handleChatLinkClick(event) {
    const link = event.target?.closest?.('a.chat-link, a.gallery-preview-card');
    if (!link?.href) return;
    event.preventDefault();
    event.stopPropagation();
    void openChatUrl(link.href);
  }

  function colorToCss(color, { opaque = false } = {}) {
    if (!color) return opaque ? '#8ba3c7' : '#8ba3c7';
    if (!Array.isArray(color)) {
      if (!opaque) return color;
      const rgbaMatch = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+)\s*)?\)$/i);
      if (!rgbaMatch) return color;
      const [, r, g, b] = rgbaMatch;
      return readableNameColor([Number(r), Number(g), Number(b)]);
    }

    const [r = 139, g = 163, b = 199, alpha = 1] = color;
    if (opaque) return readableNameColor([r, g, b]);
    const normalizedAlpha = alpha > 1 ? alpha / 255 : alpha;
    return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
  }

  function readableNameColor([r = 139, g = 163, b = 199]) {
    const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    if (luminance >= 72) return `rgb(${r}, ${g}, ${b})`;

    const lift = Math.min(1, 72 / Math.max(luminance, 1));
    const nextR = Math.min(255, Math.round(r * lift));
    const nextG = Math.min(255, Math.round(g * lift));
    const nextB = Math.min(255, Math.round(b * lift));

    if ((0.2126 * nextR) + (0.7152 * nextG) + (0.0722 * nextB) < 72) {
      return 'var(--role-user)';
    }

    return `rgb(${nextR}, ${nextG}, ${nextB})`;
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function formatShortTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function getChatUser(userId) {
    if (userId === null || userId === undefined) return null;
    if (Number(userId) === Number(appState.sessionIndex) && window.app?.self) {
      return {
        id: userId,
        username: window.app.self.username || window.app.self.name || 'You',
        color: colorToCss(window.app.self.color, { opaque: true }),
        role: window.app.self.role || appState.selfRole || 0,
        tool: window.app.self.tool || appState.currentTool || 'brush',
        afk: !!window.app.self.afk
      };
    }

    return appState.users.get(userId) || window.app?.users?.get(Number(userId)) || dmMeta.get(userId) || null;
  }

  function rememberDMUser(userOrId) {
    const user = typeof userOrId === 'object' ? userOrId : getChatUser(userOrId);
    if (!user?.id && user?.id !== 0) return;

    dmMeta.set(user.id, {
      id: user.id,
      username: user.username || user.name || `User ${user.id}`,
      color: colorToCss(user.color, { opaque: true }),
      role: user.role || 0,
      visibleIp: user.visibleIp || '',
      tool: user.tool || 'brush',
      afk: !!user.afk
    });
    dmMeta = new Map(dmMeta);
  }

  function getUnreadCount(userId) {
    const threadMessages = messages.dms.get(userId) || [];
    return threadMessages.filter((msg) => !msg.fromSelf && !msg.read).length;
  }

  function markThreadRead(userId) {
    const threadMessages = messages.dms.get(userId);
    if (!threadMessages?.length) return;

    let changed = false;
    const nextThreadMessages = threadMessages.map((msg) => {
      if (!msg.fromSelf && !msg.read) {
        changed = true;
        return { ...msg, read: true };
      }
      return msg;
    });

    if (!changed) return;

    const nextDms = new Map(messages.dms);
    nextDms.set(userId, nextThreadMessages);
    messages = {
      ...messages,
      dms: nextDms
    };
  }

  function showToast(username, message, color, options = {}) {
    if (hideRoomNotifications) return;
    const id = ++toastIdCounter;
    const truncated = message.length > 90 ? `${message.slice(0, 90)}...` : message;
    toasts = [...toasts, {
      id,
      username,
      message: truncated,
      color,
      recipientId: options.recipientId ?? null
    }];
    setTimeout(() => dismissToast(id), 4000);
    if (toasts.length > 3) toasts = toasts.slice(toasts.length - 3);
  }

  function documentNeedsNotification() {
    if (typeof document === 'undefined') return false;
    return document.visibilityState !== 'visible' || !document.hasFocus();
  }

  /* ── Should this message make a noise? ───────────────────────────────
     Toasts key off documentNeedsNotification(), but sound asks a narrower
     question: did you just watch the message land? A chat pinned open on
     this tab shows it the instant it arrives whether or not the window
     holds focus — pinging for that is pure noise. So the sound gate drops
     focus and asks only (a) is the tab actually on screen, and (b) is the
     open chat showing THIS channel. A staff line or a DM arriving while
     you sit in public still pings, because you can't see it land.
     The collapsed peek plate counts as on screen: it renders the newest
     lines of the active channel straight onto the canvas. */
  function tabIsHidden() {
    if (typeof document === 'undefined') return false;
    return document.visibilityState !== 'visible';
  }

  function isChannelOnScreen(view, dmUserId = null) {
    if (!visible || tabIsHidden()) return false;
    if (view === 'dm') {
      return activeView === 'dm' && Number(recipient?.id) === Number(dmUserId);
    }
    return activeView === view;
  }

  /** The popout window owns notifications while it's up — the in-app copy stays mute. */
  function soundIsOurs() {
    return isPopout || !isChatPopoutOpen();
  }

  function dismissToast(id) {
    toasts = toasts.filter((toast) => toast.id !== id);
  }

  function openFromToast(id) {
    const toast = toasts.find((entry) => entry.id === id);
    dismissToast(id);
    if (toast?.recipientId !== null && toast?.recipientId !== undefined) {
      void openDMThread(toast.recipientId);
      return;
    }
    show();
  }

  function createReactionList(existing = []) {
    return existing.map((reaction) => ({
      emoji: reaction.emoji,
      users: [...(reaction.users || [])]
    }));
  }

  function applyReactionToList(messageList, payload) {
    if (!Array.isArray(messageList) || !payload?.messageId || !payload?.emoji) return false;

    const messageIndex = messageList.findIndex((entry) => entry.id === payload.messageId);
    if (messageIndex === -1) return false;

    const message = cloneMessage(messageList[messageIndex]);
    const actorId = Number(payload.sessionIndex);
    let reactions = createReactionList(message.reactions);
    const reactionIndex = reactions.findIndex((reaction) => reaction.emoji === payload.emoji);

    if (reactionIndex === -1 && !payload.remove) {
      reactions = [...reactions, { emoji: payload.emoji, users: [actorId] }];
    } else if (reactionIndex !== -1) {
      const users = new Set(reactions[reactionIndex].users || []);
      if (payload.remove) users.delete(actorId);
      else users.add(actorId);

      if (users.size === 0) reactions.splice(reactionIndex, 1);
      else reactions[reactionIndex] = { ...reactions[reactionIndex], users: [...users] };
    }

    message.reactions = reactions;
    messageList[messageIndex] = message;
    return true;
  }

  function applyReactionLocally(payload) {
    let updated = applyReactionToList(messages.all, payload);
    if (updated) {
      messages.all = [...messages.all];
      return;
    }

    for (const [threadId, threadMessages] of messages.dms.entries()) {
      if (applyReactionToList(threadMessages, payload)) {
        const nextDms = new Map(messages.dms);
        nextDms.set(threadId, [...threadMessages]);
        messages = {
          ...messages,
          dms: nextDms
        };
        updated = true;
        break;
      }
    }
  }

  function toggleReaction(message, emoji) {
    if (!message?.id || !onReact) return;

    const selfId = Number(appState.sessionIndex);
    const existing = (message.reactions || []).find((reaction) => reaction.emoji === emoji);
    const reacted = existing?.users?.includes(selfId);
    const payload = {
      messageId: message.id,
      emoji,
      remove: !!reacted,
      recipientId: message.threadUserId ?? null,
      sessionIndex: selfId
    };

    applyReactionLocally(payload);
    onReact(payload);
  }

  function normalizedReactionPills(message) {
    return (message.reactions || [])
      .map((reaction) => ({
        emoji: reaction.emoji,
        count: (reaction.users || []).length,
        reactedBySelf: (reaction.users || []).includes(Number(appState.sessionIndex))
      }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  }

  function reactionUsersLabel(reaction) {
    const names = (reaction.users || [])
      .map((userId) => getChatUser(userId)?.username || (Number(userId) === Number(appState.sessionIndex) ? 'You' : `User ${userId}`));
    if (names.length === 0) return '';
    return `${reaction.emoji} by ${names.join(', ')}`;
  }

  /* Ambient HUD: the window sits faded over the canvas and solidifies on
     hover/focus (pure CSS) — this covers the third trigger, a message
     arriving while the pointer is elsewhere. Popout is a real OS window, so
     it never fades. */
  function wakeHud(holdMs = 4200) {
    if (isPopout) return;
    hudAwake = true;
    clearTimeout(hudWakeTimer);
    hudWakeTimer = setTimeout(() => { hudAwake = false; }, holdMs);

    // A message also restarts the peek stack's lifetime: the last lines stay
    // on the canvas for PEEK_QUIET_MS, then everything but the dot melts away.
    peekQuiet = false;
    clearTimeout(peekQuietTimer);
    peekQuietTimer = setTimeout(() => { peekQuiet = true; }, PEEK_QUIET_MS);
  }

  /* ── Peek stack open/close ───────────────────────────────────────────
     Collapsed is the resting state: no panel, no bar text, no composer —
     just the last few lines over the canvas. Hovering, tapping or focusing
     anything inside rebuilds the window; the pin keeps it built. */
  function expandHud() {
    if (isPopout) return;
    clearTimeout(hudCollapseTimer);
    hudCollapseTimer = null;
    hudOpen = true;
  }

  /* Hover shouldn't summon the window mid-stroke — the pointer is often
     dragging right across the HUD's screen area while inking, and popping
     the panel open under it would interrupt the stroke. A click (pointerdown)
     or keyboard focus is a deliberate ask and still opens it. */
  function expandHudOnHover() {
    if (appState.isDrawingStroke) return;
    expandHud();
  }

  function composerHasDraft() {
    if (messageInput.trim().length > 0) return true;
    return !!composerInputEl && document.activeElement === composerInputEl;
  }

  function collapseHud({ force = false } = {}) {
    clearTimeout(hudCollapseTimer);
    hudCollapseTimer = null;
    if (!force && (hudPinned || composerHasDraft())) return;
    hudOpen = false;
  }

  function scheduleCollapseHud(delay = PEEK_GRACE_MS) {
    if (isPopout || hudPinned) return;
    clearTimeout(hudCollapseTimer);
    hudCollapseTimer = setTimeout(() => {
      // Never fold away a half-typed message, and never fold out from under a
      // pointer that is still inside the window.
      const stillEngaged = composerHasDraft()
        || chatEl?.matches(':hover')
        || (chatEl && chatEl.contains(document.activeElement));
      if (stillEngaged) {
        scheduleCollapseHud(PEEK_GRACE_MS);
        return;
      }
      hudOpen = false;
    }, delay);
  }

  /** A mention or a DM outranks the peek stack — open the window uninvited. */
  function forceOpenHud() {
    if (isPopout) return;
    expandHud();
    scheduleCollapseHud(PEEK_FORCE_OPEN_MS);
  }

  /* ── Peek plate width ────────────────────────────────────────────────
     The plate shrink-wraps its lines, and `width: fit-content` cannot be
     transitioned: its computed value stays the keyword, so only the used width
     moves and the plate snaps between sizes as messages arrive. Measuring the
     live element would be self-defeating — reading its size commits the keyword
     as the transition's start value — so the natural width comes off a
     throwaway copy of the visible rows, and the real element gets that number
     as a pixel value the transition can animate. */
  const PEEK_PLATE_ROWS = 3;

  function measurePeekPlateWidth(streamEl) {
    const rows = [...streamEl.children].slice(-PEEK_PLATE_ROWS);
    if (rows.length === 0) return null;

    // Same class and same parent chain, so it picks up the peek rules — most
    // importantly the max-width that decides where long lines wrap.
    const probe = document.createElement('div');
    probe.className = streamEl.className;
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;width:fit-content;';
    for (const row of rows) probe.appendChild(row.cloneNode(true));

    streamEl.parentElement?.appendChild(probe);
    // getBoundingClientRect, not offsetWidth: offsetWidth rounds down to a whole
    // pixel, and the row's rem gap makes fractional widths the norm — losing
    // that fraction shaves the plate just under its widest line, which then
    // wraps at its first space.
    const plate = probe.getBoundingClientRect().width;
    // Rows are width:100% inside the probe, so they report the content box —
    // the plate minus its padding, without hardcoding that padding. Take the
    // widest rather than the first: a hidden row measures 0.
    const row = Math.max(0, ...[...probe.children].map((el) => el.getBoundingClientRect().width));
    probe.remove();
    return plate > 0 ? { plate: Math.ceil(plate), row: Math.ceil(row) } : null;
  }

  function syncPeekPlateWidth(streamEl) {
    if (!streamEl) return;
    // Expanded, the stream is the full-width scroll area again — a width left
    // over from the collapsed state would strand it narrow.
    if (!isPeekCollapsed) {
      streamEl.style.removeProperty('--peek-plate-w');
      streamEl.style.removeProperty('--peek-row-w');
      return;
    }

    const measured = measurePeekPlateWidth(streamEl);
    if (!measured) {
      streamEl.style.removeProperty('--peek-plate-w');
      streamEl.style.removeProperty('--peek-row-w');
      return;
    }

    /* Two widths, not one. The plate's animates; the rows' is applied flat, so
       the lines are already laid out at their final width while the plate is
       still growing into it. Without that the rows reflow every frame of the
       transition — a two-word message spends the animation wrapped across two
       lines and then snaps back to one. */
    streamEl.style.setProperty('--peek-plate-w', `${measured.plate}px`);
    if (measured.row > 0) {
      streamEl.style.setProperty('--peek-row-w', `${measured.row}px`);
    } else {
      streamEl.style.removeProperty('--peek-row-w');
    }
  }

  function toggleHudPin() {
    hudPinned = !hudPinned;
    if (hudPinned) {
      expandHud();
    } else {
      scheduleCollapseHud(PEEK_GRACE_MS);
    }
    try {
      localStorage.setItem(CHAT_PIN_STORAGE_KEY, hudPinned ? '1' : '0');
    } catch {
      /* private mode — the pin just won't survive a reload */
    }
  }

  function handleHudKeydown(event) {
    if (event.key !== 'Escape' || isPopout || !hudOpen) return;
    collapseHud({ force: true });
    composerInputEl?.blur();
  }

  onDestroy(() => {
    clearTimeout(hudWakeTimer);
    clearTimeout(peekQuietTimer);
    clearTimeout(hudCollapseTimer);
  });

  function addPublicMessage(message) {
    messages.all = [...messages.all, message];

    if (message.type === 'system') return;

    wakeHud();

    if (Number(message.userId) !== Number(appState.sessionIndex) && messageMentionsSelf(message.text)) {
      forceOpenHud();
    }

    const isIncoming = Number(message.userId) !== Number(appState.sessionIndex);

    if ((!visible || documentNeedsNotification()) && !isChatPopoutOpen()) {
      appState.chatUnreadCount++;
      const preview = message.type === 'image' ? `${message.text ? `${message.text} ` : ''}[image]` : message.text;
      showToast(message.username, preview || '[image]', message.color);
    }

    // Your own line never rings — you just typed it.
    if (isIncoming && soundIsOurs() && !isChannelOnScreen('all')) {
      if (messageMentionsSelf(message.text)) playMentionPing();
      else playSfx('chat');
    }
  }

  function addStaffChannelMessage(message) {
    messages.staff = [...messages.staff, message];
    wakeHud();
    if (Number(message.userId) !== Number(appState.sessionIndex) && messageMentionsSelf(message.text)) {
      forceOpenHud();
    }
    const popoutOpen = isChatPopoutOpen();
    const isIncoming = Number(message.userId) !== Number(appState.sessionIndex);
    const shouldCountUnread = !popoutOpen && (!visible || activeView !== 'staff' || documentNeedsNotification());
    if (shouldCountUnread) {
      appState.chatUnreadCount++;
      const preview = message.type === 'image' ? `${message.text ? `${message.text} ` : ''}[image]` : message.text;
      showToast(message.username, `[Staff] ${preview || '[image]'}`, message.color);
    }

    if (isIncoming && soundIsOurs() && !isChannelOnScreen('staff')) {
      if (messageMentionsSelf(message.text)) playMentionPing();
      else playSfx('staff');
    }
  }

  function addDirectMessage(userId, message) {
    rememberDMUser(userId);
    const threadMessages = messages.dms.get(userId) || [];
    const nextDms = new Map(messages.dms);
    nextDms.set(userId, [...threadMessages, message]);
    messages = {
      ...messages,
      dms: nextDms
    };
    wakeHud();
    if (!message.fromSelf) forceOpenHud();

    if (!message.fromSelf && (!visible || documentNeedsNotification()) && !isChatPopoutOpen()) {
      appState.chatUnreadCount++;
      const user = getChatUser(userId);
      const preview = message.type === 'image' ? `${message.text ? `${message.text} ` : ''}[image]` : message.text;
      showToast(
        user?.username || 'DM',
        `[DM] ${preview || '[image]'}`,
        user?.color || '#8ba3c7',
        { recipientId: userId }
      );
    }

    // A DM always rings unless you are sitting in that very thread — an open
    // public chat is no reason to miss one.
    if (!message.fromSelf && soundIsOurs() && !isChannelOnScreen('dm', userId)) {
      playSfx('staff');
    }
  }

  function activeHeaderTitle() {
    if (activeView === 'all') return 'Public';
    if (activeView === 'staff') return 'Staff';
    if (activeView === 'directory') return 'Private messages';
    return recipient?.username || 'Direct message';
  }

  function activeHeaderSubtitle() {
    if (activeView === 'all') return '';
    if (activeView === 'staff') return '';
    if (activeView === 'directory') {
      return `${directoryUsers.length} online contact${directoryUsers.length === 1 ? '' : 's'}`;
    }
    return recipient ? 'Private conversation' : 'Select someone to message';
  }

  function formatModeratorMeta(user) {
    if (!user || appState.selfRole < 4) return '';
    const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    const roleName = roleNames[user.role || 0] || 'Guest';
    return user.visibleIp ? `${roleName} | ${user.visibleIp}` : roleName;
  }

  function displayChatName(name) {
    const value = String(name || '');
    const max = isMobile() ? CHAT_NAME_DISPLAY_MAX_MOBILE : CHAT_NAME_DISPLAY_MAX;
    if (value.length <= max) return value;
    return `${value.slice(0, max - 1)}…`;
  }

  /* The name column truncates, so the tooltip has to carry the full name —
     the moderator meta is appended rather than replacing it. */
  function messageUserTitle(msg) {
    if (msg?.userId === null || msg?.userId === undefined) return msg?.username || '';
    const meta = formatModeratorMeta(getChatUser(msg.userId));
    return meta ? `${msg.username} — ${meta}` : msg.username;
  }

  function directoryUserMeta(user) {
    const meta = formatModeratorMeta(user);
    if (user?.afk) return meta ? `${meta} | Inactive` : 'Inactive';
    return meta || 'Tap to open thread';
  }

  function getChatToolIconUrl(user) {
    if (user?.afk) return INACTIVE_TOOL_ICON;
    return CHAT_TOOL_ICONS[user?.tool] || CHAT_TOOL_ICONS.brush;
  }

  function getChatToolIconAlt(user) {
    if (user?.afk) return 'Inactive';
    return `${user?.tool || 'brush'} tool`;
  }

  function getRoleClass(userId, storedRole = null) {
    const role = storedRole !== null ? storedRole : (getChatUser(userId)?.role ?? 0);
    if (role >= 9) return 'rank-deity';
    if (role === 8) return 'rank-holy';
    if (role === 7) return 'rank-noble';
    if (role >= 5) return 'rank-admin';
    if (role === 4) return 'rank-mod';
    if (role === 3) return 'rank-helper';
    if (role === 2) return 'rank-trusted';
    if (role >= 1) return 'rank-user';
    return 'rank-guest';
  }

  function openUserContextMenu(event, userId) {
    if (isPopout) return;
    if (!window.app || userId === null || userId === undefined) return;

    if (Number(userId) === Number(appState.sessionIndex)) {
      window.app._showSelfContextMenu?.(event);
      return;
    }

    const user = window.app.users?.get(Number(userId)) || appState.users.get(userId);
    if (user) window.app.moderation?.showContextMenu(event, Number(userId), user);
  }

  function scrollToBottom(element) {
    if (!element) return;
    Promise.resolve().then(() => {
      element.scrollTop = element.scrollHeight;
    });
  }

  function isNearBottom(element, threshold = 28) {
    if (!element) return true;
    return (element.scrollHeight - element.scrollTop - element.clientHeight) <= threshold;
  }

  function syncPinnedState(view, element) {
    if (!view) return;
    chatPinnedToBottom = {
      ...chatPinnedToBottom,
      [view]: isNearBottom(element)
    };
  }

  function handleMessageScroll(view, event) {
    syncPinnedState(view, event.currentTarget);
  }

  // A message arriving mid-gesture forces scrollTop back to the bottom before
  // the scroll event above has a chance to register the user as unpinned —
  // wheel/touch input never gets far enough past the near-bottom threshold to
  // escape it. Track "hand is on the scroll" separately so the auto-scroll
  // effects can back off for the duration of the gesture instead of fighting it.
  let userScrollActive = $state(false);
  let userScrollTimer = null;

  function markUserScrollActive() {
    userScrollActive = true;
    clearTimeout(userScrollTimer);
    userScrollTimer = setTimeout(() => {
      userScrollActive = false;
    }, 200);
  }

  function jumpToPresent() {
    const view = activeView === 'staff' ? 'staff' : activeView === 'dm' ? 'dm' : 'all';
    const element = view === 'dm' ? dmMessagesEl : publicMessagesEl;
    scrollToBottom(element);
    chatPinnedToBottom = {
      ...chatPinnedToBottom,
      [view]: true
    };
  }

  function clampChatPosition(left, top) {
    if (!chatEl) return { left, top };
    const maxLeft = Math.max(8, window.innerWidth - chatEl.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - chatEl.offsetHeight - 8);
    return {
      left: Math.max(8, Math.min(maxLeft, left)),
      top: Math.max(8, Math.min(maxTop, top))
    };
  }

  function setChatPosition(left, top) {
    if (!chatEl) return;
    const next = clampChatPosition(left, top);
    chatEl.style.left = `${next.left}px`;
    chatEl.style.top = `${next.top}px`;
    chatEl.style.right = 'auto';
    chatEl.style.bottom = 'auto';
  }

  function clearChatPosition() {
    if (!chatEl) return;
    chatEl.style.left = '';
    chatEl.style.top = '';
    chatEl.style.right = '';
    chatEl.style.bottom = '';
  }

  function applyStoredPositionForMode(mode = chatMode) {
    if (!chatEl) return;
    // On mobile the chat always opens at its CSS-centered spot; dragging
    // within the session still works, it just doesn't persist.
    if (isMobile()) {
      clearChatPosition();
      return;
    }
    const positions = loadChatPositions();
    const saved = positions?.[mode];
    if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) {
      clearChatPosition();
      return;
    }
    setChatPosition(saved.left, saved.top);
  }

  function scheduleApplyStoredPosition(mode = chatMode) {
    requestAnimationFrame(() => {
      applyStoredPositionForMode(mode);
      applyStoredSizeForMode(mode);
    });
  }

  function persistCurrentChatPosition(mode = chatMode) {
    if (!chatEl) return;
    const computed = window.getComputedStyle(chatEl);
    if (computed.left === 'auto' || computed.top === 'auto') return;

    const left = parseFloat(computed.left);
    const top = parseFloat(computed.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;

    const positions = loadChatPositions();
    const existing = positions[mode] || {};
    const clamped = clampChatPosition(left, top);
    positions[mode] = { ...existing, left: clamped.left, top: clamped.top };
    persistChatPositions(positions);
  }

  function getPointerCoords(event) {
    if (event.touches?.[0]) {
      return { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    return { x: event.clientX, y: event.clientY };
  }

  function isPointerActive(event) {
    if (event.touches) return event.touches.length > 0;
    return (event.buttons & 1) === 1;
  }

  function startDrag(event) {
    if (isPopout) return;
    if (event.target.closest('button, textarea, input, a, label')) return;
    if (!chatEl) return;

    const rect = chatEl.getBoundingClientRect();
    setChatPosition(rect.left, rect.top);

    const { x, y } = getPointerCoords(event);
    dragOffsetX = x - rect.left;
    dragOffsetY = y - rect.top;
    isDragging = true;
    event.preventDefault();
  }

  function onDrag(event) {
    if (!isDragging || !chatEl) return;
    if (!isPointerActive(event)) {
      endDrag();
      return;
    }

    const { x, y } = getPointerCoords(event);
    const nextLeft = Math.max(8, Math.min(window.innerWidth - chatEl.offsetWidth - 8, x - dragOffsetX));
    const nextTop = Math.max(8, Math.min(window.innerHeight - chatEl.offsetHeight - 8, y - dragOffsetY));

    setChatPosition(nextLeft, nextTop);
  }

  function endDrag() {
    if (isDragging) persistCurrentChatPosition();
    isDragging = false;
  }

  const MIN_CHAT_WIDTH = 280;
  const MIN_CHAT_HEIGHT = 240;
  let isResizing = $state(false);
  let resizeStart = null;
  let resizeDirection = $state('');

  function applyStoredSizeForMode(mode = chatMode) {
    if (!chatEl) return;
    // Mobile sizing is CSS-driven (html[data-mobile] override); stored
    // desktop geometry would fight it.
    if (isMobile()) {
      chatEl.style.width = '';
      chatEl.style.height = '';
      return;
    }
    const positions = loadChatPositions();
    const saved = positions?.[mode];
    if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
      chatEl.style.width = `${saved.width}px`;
      chatEl.style.height = `${saved.height}px`;
    } else {
      chatEl.style.width = '';
      chatEl.style.height = '';
    }
  }

  function startResize(event, direction = 'se') {
    if (isPopout || !chatEl || !direction) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = chatEl.getBoundingClientRect();
    setChatPosition(rect.left, rect.top);
    chatEl.style.width = `${rect.width}px`;
    chatEl.style.height = `${rect.height}px`;

    const { x, y } = getPointerCoords(event);
    resizeStart = {
      x,
      y,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
    resizeDirection = direction;
    isResizing = true;
  }

  function onResize(event) {
    if (!isResizing || !chatEl || !resizeStart) return;
    if (!isPointerActive(event)) {
      endResize();
      return;
    }

    const { x, y } = getPointerCoords(event);
    const deltaX = x - resizeStart.x;
    const deltaY = y - resizeStart.y;
    let nextLeft = resizeStart.left;
    let nextTop = resizeStart.top;
    let nextWidth = resizeStart.width;
    let nextHeight = resizeStart.height;

    if (resizeDirection.includes('e')) {
      const maxWidth = Math.max(MIN_CHAT_WIDTH, window.innerWidth - resizeStart.left - 8);
      nextWidth = Math.max(MIN_CHAT_WIDTH, Math.min(maxWidth, resizeStart.width + deltaX));
    }

    if (resizeDirection.includes('s')) {
      const maxHeight = Math.max(MIN_CHAT_HEIGHT, window.innerHeight - resizeStart.top - 8);
      nextHeight = Math.max(MIN_CHAT_HEIGHT, Math.min(maxHeight, resizeStart.height + deltaY));
    }

    if (resizeDirection.includes('w')) {
      const maxLeft = resizeStart.left + resizeStart.width - MIN_CHAT_WIDTH;
      nextLeft = Math.max(8, Math.min(maxLeft, resizeStart.left + deltaX));
      nextWidth = Math.max(MIN_CHAT_WIDTH, resizeStart.width - (nextLeft - resizeStart.left));
    }

    if (resizeDirection.includes('n')) {
      const maxTop = resizeStart.top + resizeStart.height - MIN_CHAT_HEIGHT;
      nextTop = Math.max(8, Math.min(maxTop, resizeStart.top + deltaY));
      nextHeight = Math.max(MIN_CHAT_HEIGHT, resizeStart.height - (nextTop - resizeStart.top));
    }

    setChatPosition(nextLeft, nextTop);
    chatEl.style.width = `${nextWidth}px`;
    chatEl.style.height = `${nextHeight}px`;
  }

  function endResize() {
    if (!isResizing) return;
    isResizing = false;
    resizeStart = null;
    resizeDirection = '';
    persistCurrentChatSize();
  }

  function persistCurrentChatSize(mode = chatMode) {
    if (!chatEl) return;
    const rect = chatEl.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;

    const positions = loadChatPositions();
    const existing = positions[mode] || {};
    positions[mode] = {
      ...existing,
      left: Number.isFinite(existing.left) ? existing.left : rect.left,
      top: Number.isFinite(existing.top) ? existing.top : rect.top,
      width: rect.width,
      height: rect.height
    };
    persistChatPositions(positions);
  }

  function isImageFile(file) {
    return !!file && typeof file.type === 'string' && CHAT_UPLOAD_MIME_TYPES.has(file.type);
  }

  function emojiInsertValue(emoji) {
    return emoji;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read processed image'));
      reader.readAsDataURL(blob);
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to process image'));
        }
      }, type, quality);
    });
  }

  async function loadImageForCompression(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file);
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = 'async';
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Failed to decode image'));
        image.src = objectUrl;
      });
      return image;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function constrainImageSize(width, height, scale = 1) {
    let nextScale = Math.min(1, scale);
    if (width * nextScale > MAX_CHAT_UPLOAD_DIMENSION) {
      nextScale = Math.min(nextScale, MAX_CHAT_UPLOAD_DIMENSION / width);
    }
    if (height * nextScale > MAX_CHAT_UPLOAD_DIMENSION) {
      nextScale = Math.min(nextScale, MAX_CHAT_UPLOAD_DIMENSION / height);
    }
    const pixels = width * height * nextScale * nextScale;
    if (pixels > MAX_CHAT_UPLOAD_PIXELS) {
      nextScale = Math.min(nextScale, Math.sqrt(MAX_CHAT_UPLOAD_PIXELS / (width * height)));
    }

    return {
      width: Math.max(1, Math.round(width * nextScale)),
      height: Math.max(1, Math.round(height * nextScale))
    };
  }

  async function compressChatImage(file) {
    const source = await loadImageForCompression(file);
    const sourceWidth = source.width || source.naturalWidth || 0;
    const sourceHeight = source.height || source.naturalHeight || 0;

    if (!sourceWidth || !sourceHeight) {
      source.close?.();
      throw new Error('Unable to read image dimensions');
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      source.close?.();
      throw new Error('Failed to prepare image for chat upload.');
    }
    let bestBlob = null;
    const targetTypes = file.type === 'image/png'
      ? ['image/webp', 'image/png', 'image/jpeg']
      : ['image/webp', 'image/jpeg', file.type];
    const scaleSteps = [1, 0.85, 0.7, 0.55, 0.4];
    const qualitySteps = [0.92, 0.84, 0.76, 0.68, 0.6];

    try {
      for (const scaleStep of scaleSteps) {
        const { width, height } = constrainImageSize(sourceWidth, sourceHeight, scaleStep);
        canvas.width = width;
        canvas.height = height;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height);

        for (const type of targetTypes) {
          const attempts = type === 'image/png' ? [undefined] : qualitySteps;
          for (const quality of attempts) {
            const blob = await canvasToBlob(canvas, type, quality);
            if (!bestBlob || blob.size < bestBlob.size) {
              bestBlob = blob;
            }
            if (blob.size <= MAX_CHAT_UPLOAD_BYTES) {
              return blob;
            }
          }
        }
      }
    } finally {
      source.close?.();
    }

    throw new Error(
      bestBlob
        ? 'Image is still too large for chat after compression. Try a smaller image.'
        : 'Failed to process image for chat upload.'
    );
  }

  async function queueComposerImage(file) {
    if (!isImageFile(file)) {
      showToast('Chat', 'Only PNG, JPEG, WebP, and GIF are supported in chat.', '#ff9b73');
      return;
    }
    try {
      let dataUrl = '';
      if (file.type === 'image/gif') {
        if (file.size > MAX_CHAT_UPLOAD_BYTES) {
          showToast('Chat', 'GIFs must be under 4.5 MB for chat.', '#ff9b73');
          return;
        }
        dataUrl = await readFileAsDataUrl(file);
      } else {
        const processedBlob = await compressChatImage(file);
        dataUrl = await blobToDataUrl(processedBlob);
      }

      composerImage = {
        name: file.name || 'image',
        dataUrl
      };
    } catch (error) {
      showToast('Chat', error?.message || 'Failed to prepare image for chat.', '#ff9b73');
    }
  }

  async function handleFileInputChange(event) {
    const file = event.currentTarget?.files?.[0];
    if (!file) return;
    await queueComposerImage(file);
    event.currentTarget.value = '';
  }

  function openFilePicker() {
    fileInputEl?.click();
  }

  function removeComposerImage() {
    composerImage = null;
  }

  async function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    isDropTarget = false;
    dropDepth = 0;

    const file = [...(event.dataTransfer?.files || [])].find(isImageFile);
    if (file) await queueComposerImage(file);
  }

  function handleDragEnter(event) {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith('image/'))) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepth += 1;
    isDropTarget = true;
  }

  function handleDragOver(event) {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith('image/'))) return;
    event.preventDefault();
    event.stopPropagation();
    isDropTarget = true;
  }

  function handleDragLeave(event) {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith('image/'))) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) isDropTarget = false;
  }

  function insertEmoji(emoji) {
    messageInput = `${messageInput}${emojiInsertValue(emoji)}`;
  }

  function openEmojiPicker() {
    showEmojiPicker = !showEmojiPicker;
  }

  function openImageViewer(imageData) {
    expandedImage = imageData || null;
  }

  function closeImageViewer() {
    expandedImage = null;
  }

  function normalizeRecipient(userOrId, fallback = null) {
    const user = typeof userOrId === 'object' && userOrId
      ? userOrId
      : fallback || getChatUser(userOrId) || dmMeta.get(userOrId) || null;
    const userId = user?.id ?? userOrId;
    if (userId === undefined || userId === null) return null;

    return {
      id: userId,
      username: user?.username || user?.name || `User ${userId}`,
      color: colorToCss(user?.color, { opaque: true }),
      role: user?.role || 0,
      visibleIp: user?.visibleIp || ''
    };
  }

  async function openDMThread(userOrId, fallback = null) {
    const nextRecipient = normalizeRecipient(userOrId, fallback);
    if (!nextRecipient) return false;

    rememberDMUser(nextRecipient);
    if (!visible) {
      appState.chatVisible = true;
      await tick();
    }

    appState.dmRecipient = nextRecipient;
    activeView = 'dm';
    appState.chatVisible = true;
    appState.chatUnreadCount = 0;
    toasts = [];
    await tick();

    if (!isPopout && chatEl) scheduleApplyStoredPosition(chatMode);
    if (nextRecipient.id !== undefined && nextRecipient.id !== null) markThreadRead(nextRecipient.id);
    if (chatPinnedToBottom.dm) scrollToBottom(dmMessagesEl);
    void focusComposer();

    return true;
  }

  export function addChatMessage(username, message, color, userId = null, messageId = createMessageId(), userRole = 0) {
    addPublicMessage(createBaseMessage({
      id: messageId,
      type: 'message',
      text: message,
      username,
      color: colorToCss(color, { opaque: true }),
      userId,
      userRole
    }));
  }

  export function addChatImage(imageData, user, messageId = createMessageId()) {
    const username = user?.username || user?.name || 'User';
    const color = colorToCss(user?.color, { opaque: true });
    const userId = user?.id ?? user?.sessionIndex ?? null;
    const userRole = user?.role ?? 0;

    addPublicMessage(createBaseMessage({
      id: messageId,
      type: 'image',
      imageData,
      username,
      color,
      userId,
      userRole
    }));
  }

  export function addStaffMessage(username, message, color, userId = null, messageId = createMessageId(), userRole = 0) {
    addStaffChannelMessage(createBaseMessage({
      id: messageId,
      type: 'message',
      text: message,
      username,
      color,
      userId,
      userRole
    }));
  }

  export function addStaffImage(imageData, user, messageId = createMessageId()) {
    const username = user?.username || user?.name || 'User';
    const color = colorToCss(user?.color, { opaque: true });
    const userId = user?.id ?? user?.sessionIndex ?? null;
    const userRole = user?.role ?? 0;

    addStaffChannelMessage(createBaseMessage({
      id: messageId,
      type: 'image',
      imageData,
      username,
      color,
      userId,
      userRole
    }));
  }

  export function addSystemMessage(message) {
    addPublicMessage(createBaseMessage({
      type: 'system',
      text: message,
      username: 'System',
      color: '#8fd8ff'
    }));
  }

  export function addChatDM(message, senderId, fromSelf, messageId = createMessageId(), userRole = 0) {
    rememberDMUser(senderId);
    addDirectMessage(senderId, createBaseMessage({
      id: messageId,
      type: 'message',
      text: message,
      fromSelf,
      read: fromSelf || (visible && activeView === 'dm' && Number(recipient?.id) === Number(senderId)),
      threadUserId: senderId,
      userRole
    }));
  }

  export function addDMImage(imageData, senderId, fromSelf, messageId = createMessageId(), userRole = 0) {
    rememberDMUser(senderId);
    addDirectMessage(senderId, createBaseMessage({
      id: messageId,
      type: 'image',
      imageData,
      fromSelf,
      read: fromSelf || (visible && activeView === 'dm' && Number(recipient?.id) === Number(senderId)),
      threadUserId: senderId,
      userRole
    }));
  }

  export function applyReaction(payload) {
    applyReactionLocally(payload);
  }

  function removeMessageFromList(list, messageId) {
    const index = list.findIndex((entry) => entry.id === messageId);
    if (index === -1) return null;
    return [...list.slice(0, index), ...list.slice(index + 1)];
  }

  export function removeMessage(messageId) {
    if (!messageId) return;

    const nextAll = removeMessageFromList(messages.all, messageId);
    if (nextAll) messages.all = nextAll;

    const nextStaff = removeMessageFromList(messages.staff, messageId);
    if (nextStaff) messages.staff = nextStaff;
  }

  let spamWarning = $state(null); // { level, cooldownMs, until }
  let silenced = $state(false);
  let spamCooldownRemainingMs = $state(0);
  let spamCooldownTimer = null;

  export function setSilenced(value) {
    silenced = !!value;
  }

  function tickSpamCooldown() {
    if (!spamWarning) return;
    const remaining = spamWarning.until - Date.now();
    spamCooldownRemainingMs = Math.max(0, remaining);
    if (remaining <= 0) {
      clearInterval(spamCooldownTimer);
      spamCooldownTimer = null;
      // Once acknowledged, the card is only showing a countdown — dismiss it
      // itself once the cooldown clears instead of waiting for another click.
      if (spamWarning?.acknowledged) spamWarning = null;
    }
  }

  export function showSpamWarning(level, cooldownMs) {
    clearInterval(spamCooldownTimer);
    spamWarning = { level, cooldownMs, until: Date.now() + (cooldownMs || 0), acknowledged: false };
    spamCooldownRemainingMs = cooldownMs || 0;
    if (cooldownMs > 0) {
      spamCooldownTimer = setInterval(tickSpamCooldown, 250);
    }
  }

  function acknowledgeSpamWarning() {
    if (!spamWarning) return;
    if (spamWarning.level >= 3) {
      spamWarning = null;
      return;
    }
    spamWarning = { ...spamWarning, acknowledged: true };
  }

  let deleteMenu = $state(null); // { msg, x, y, staff }
  let longPressTimer = null;

  function canDeleteMessages() {
    return appState.selfRole >= 4; // MOD(4)+
  }

  function openDeleteMenu(event, msg, isStaffChannel) {
    if (!canDeleteMessages() || msg.type === 'system') return;
    event.preventDefault();
    event.stopPropagation();
    const point = event.touches?.[0] || event;
    deleteMenu = { msg, x: point.clientX, y: point.clientY, staff: isStaffChannel };
  }

  function closeDeleteMenu() {
    deleteMenu = null;
  }

  function confirmDeleteMessage() {
    if (!deleteMenu) return;
    onDeleteMessage?.(deleteMenu.msg.id, deleteMenu.staff);
    removeMessage(deleteMenu.msg.id);
    closeDeleteMenu();
  }

  function startLongPress(event, msg, isStaffChannel) {
    if (!canDeleteMessages() || msg.type === 'system') return;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => openDeleteMenu(event, msg, isStaffChannel), 500);
  }

  function cancelLongPress() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  export function openDM(userId, user = null) {
    void openDMThread(userId, user);
  }

  function serializeMessages() {
    return {
      all: messages.all.map(cloneMessage),
      staff: messages.staff.map(cloneMessage),
      dms: [...messages.dms.entries()].map(([userId, threadMessages]) => [
        userId,
        threadMessages.map(cloneMessage)
      ])
    };
  }

  export function getSnapshot() {
    return {
      messages: serializeMessages(),
      dmMeta: [...dmMeta.entries()].map(([userId, user]) => [userId, { ...user }]),
      activeView,
      recipient: recipient ? { ...recipient } : null
    };
  }

  export function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;

    if (snapshot.messages) {
      messages = {
        all: (snapshot.messages.all || []).map(cloneMessage),
        staff: (snapshot.messages.staff || []).map(cloneMessage),
        dms: new Map(
          (snapshot.messages.dms || []).map(([userId, threadMessages]) => [
            userId,
            (threadMessages || []).map(cloneMessage)
          ])
        )
      };
    }

    if (Array.isArray(snapshot.dmMeta)) {
      dmMeta = new Map(snapshot.dmMeta.map(([userId, user]) => [userId, { ...user }]));
    }

    if (typeof snapshot.activeView === 'string') {
      activeView = snapshot.activeView;
    }

    if ('recipient' in snapshot) {
      appState.dmRecipient = snapshot.recipient;
    }
  }

  onMount(() => {
    isDesktopClient = isTauriDesktop();

    try {
      hudPinned = localStorage.getItem(CHAT_PIN_STORAGE_KEY) === '1';
    } catch {
      hudPinned = false;
    }
    if (hudPinned) hudOpen = true;

    if (!isPopout || !isDesktopClient) {
      return;
    }

    let unlistenResize = null;
    let active = true;

    void import('@tauri-apps/api/webviewWindow').then(async ({ getCurrentWebviewWindow }) => {
      if (!active) return;
      desktopWindowApi = getCurrentWebviewWindow();
      await syncDesktopWindowState();
      unlistenResize = await desktopWindowApi.onResized(() => {
        void syncDesktopWindowState();
      });
    });

    return () => {
      active = false;
      desktopWindowApi = null;
      unlistenResize?.();
    };
  });

  $effect(() => {
    messages.all.length;
    if (visible && activeView === 'all' && chatPinnedToBottom.all && !userScrollActive) scrollToBottom(publicMessagesEl);
  });

  $effect(() => {
    messages.staff.length;
    if (visible && activeView === 'staff' && chatPinnedToBottom.staff && !userScrollActive) scrollToBottom(publicMessagesEl);
  });

  $effect(() => {
    if (!canAccessStaff && activeView === 'staff') {
      activeView = 'all';
    }
  });

  /* Opening the chat deliberately (the toolbar button, a DM link) has to show
     the window, not the collapsed dot — then hand it back to the peek stack if
     the pointer never arrives. */
  $effect(() => {
    if (!visible) {
      collapseHud({ force: true });
      return;
    }
    forceOpenHud();
  });

  $effect(() => {
    const recipientId = recipient?.id;
    if (recipientId === undefined || recipientId === null) return;
    if (activeView !== 'dm') activeView = 'dm';
    markThreadRead(recipientId);
  });

  $effect(() => {
    activeView;
    recipient?.id;
    activeDMMessages.length;
    if (visible && activeView === 'dm' && recipient) {
      markThreadRead(recipient.id);
      if (chatPinnedToBottom.dm && !userScrollActive) scrollToBottom(dmMessagesEl);
    }
  });

  $effect(() => {
    activeView;
    visible;
    if (!visible) return;
    Promise.resolve().then(() => {
      if (activeView === 'dm') syncPinnedState('dm', dmMessagesEl);
      else if (activeView === 'staff') syncPinnedState('staff', publicMessagesEl);
      else if (activeView === 'all') syncPinnedState('all', publicMessagesEl);
    });
  });

  /* Peek -> expanded: the collapsed plate is `overflow: hidden` and shrink-wraps
     its last rows, so the stream sits at scrollTop 0 for as long as it stays
     folded. Handing that back to the scrolling panel untouched drops the reader
     on the OLDEST message — but the plate they just hovered was showing the
     newest, so re-anchor to the tail every time the window rebuilds itself.
     Untracked inside: this must fire on the fold/unfold, not on every scroll. */
  $effect(() => {
    if (!visible || isPeekCollapsed) return;
    untrack(() => {
      const view = activeView === 'staff' ? 'staff' : activeView === 'dm' ? 'dm' : 'all';
      scrollToBottom(view === 'dm' ? dmMessagesEl : publicMessagesEl);
      chatPinnedToBottom = { ...chatPinnedToBottom, [view]: true };
    });
  });

  $effect(() => {
    if (visible) appState.chatUnreadCount = 0;
  });

  // Re-pin the collapsed plate's width whenever its content, its channel or the
  // collapsed state itself changes.
  $effect(() => {
    isPeekCollapsed;
    activeView;
    messages.all;
    messages.staff;
    messages.dms;
    windowWidth;
    syncPeekPlateWidth(publicMessagesEl);
    syncPeekPlateWidth(dmMessagesEl);
  });

  $effect(() => {
    const focusKey = visible && activeView !== 'directory'
      ? `${activeView}:${recipient?.id ?? ''}`
      : '';

    if (!focusKey) {
      lastComposerFocusKey = '';
      return;
    }

    if (focusKey === lastComposerFocusKey) return;
    lastComposerFocusKey = focusKey;
    void focusComposer();
  });

  $effect(() => {
    messageInput;
    activeView;
    appState.users.size;
    Promise.resolve().then(syncMentionSuggestion);
  });

  $effect(() => {
    visible;
    effectiveChatMode;
    chatEl;
    if (!isPopout && visible && chatEl) {
      scheduleApplyStoredPosition(effectiveChatMode);
    }
  });

  $effect(() => {
    const handleWindowResize = () => {
      windowWidth = window.innerWidth;
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  });

  $effect(() => {
    if (isPopout || !visible || !chatEl) return;

    const handleResize = () => {
      const computed = window.getComputedStyle(chatEl);
      if (computed.left === 'auto' || computed.top === 'auto') return;
      const left = parseFloat(computed.left);
      const top = parseFloat(computed.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;
      setChatPosition(left, top);
      persistCurrentChatPosition();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  });

  $effect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        endDrag();
      }
    };

    const handleBlurOrHide = () => {
      endDrag();
      endResize();
    };

    const handleDocumentKeydown = (event) => {
      if (event.key !== 'Escape' || (!visible && !isPopout)) return;
      event.preventDefault();
      event.stopPropagation();

      // Popout is a real OS window and mobile has no minimized/peek state to
      // fold into — Escape just closes there, as before.
      if (isPopout || isMobile()) {
        void closeChatWindow();
        return;
      }

      // First Escape folds the ambient HUD down to its minimized peek dot;
      // a second Escape while already minimized closes the chat outright.
      if (hudPinned || hudOpen) {
        if (hudPinned) {
          hudPinned = false;
          try {
            localStorage.setItem(CHAT_PIN_STORAGE_KEY, '0');
          } catch {
            /* private mode — the pin just won't survive a reload */
          }
        }
        collapseHud({ force: true });
        composerInputEl?.blur();
        return;
      }

      hide();
    };

    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('touchmove', onDrag, { passive: false });
    window.addEventListener('touchend', endDrag);
    window.addEventListener('mousemove', onResize);
    window.addEventListener('mouseup', endResize);
    window.addEventListener('touchmove', onResize, { passive: false });
    window.addEventListener('touchend', endResize);
    window.addEventListener('blur', handleBlurOrHide);
    document.addEventListener('keydown', handleDocumentKeydown);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('mousemove', onDrag);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('touchmove', onDrag);
      window.removeEventListener('touchend', endDrag);
      window.removeEventListener('mousemove', onResize);
      window.removeEventListener('mouseup', endResize);
      window.removeEventListener('touchmove', onResize);
      window.removeEventListener('touchend', endResize);
      window.removeEventListener('blur', handleBlurOrHide);
      document.removeEventListener('keydown', handleDocumentKeydown);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });
</script>

{#snippet messageContent(message)}
  {#if message.type === 'system'}
    <p class="message-text">{message.text}</p>
  {:else}
    {@const galleryLinks = extractGalleryLinks(message.text)}
    <div class="message-content-row">
      <div class="message-copy">
        {#if message.type === 'image'}
          <button class="chat-image-card" onclick={() => openImageViewer(message.imageData)} type="button">
            <img src={message.imageData} alt="Chat upload" class="chat-image" />
          </button>
        {/if}
        {#if message.text}
          <p class="message-text">{@html linkify(message.text)}</p>
        {/if}
        {#each galleryLinks as link (link.id)}
          {@const preview = getGalleryPreview(link)}
          {#if preview && !preview.missing}
            <a class="gallery-preview-card" href={preview.url} target="_blank" rel="noopener noreferrer">
              {#if preview.nsfw}
                <span class="gallery-preview-fallback">NSFW</span>
              {:else}
                <img src={preview.thumbUrl} alt={preview.title} class="gallery-preview-image" loading="lazy" />
              {/if}
              <span class="gallery-preview-copy">
                <strong>{preview.title}</strong>
                <span>{preview.author}</span>
              </span>
            </a>
          {/if}
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet channelRow(msg, isStaffChannel = false)}
  <article
    class="message-row"
    class:system={msg.type === 'system'}
    class:grouped={msg.groupedWithPrevious}
    class:group-tail={!msg.groupedWithNext}
    oncontextmenu={(event) => openDeleteMenu(event, msg, isStaffChannel)}
    ontouchstart={(event) => startLongPress(event, msg, isStaffChannel)}
    ontouchend={cancelLongPress}
    ontouchmove={cancelLongPress}
  >
    <span class="message-time" title={formatTime(msg.timestamp)}>{msg.groupedWithPrevious ? '' : formatTime(msg.timestamp)}</span>
    <!-- Name column. The name is always in the DOM and grouped rows hide it in
         CSS rather than dropping it, so the peek stack — which shows only the
         last few lines, often none of them the one that carried the name — can
         put it back. A run of messages from one person then lines up under the
         first instead of the follow-ups jumping left into the name's gutter. -->
    {#if msg.type !== 'system'}
      <div class="message-author">
        <button class={`message-user ${getRoleClass(msg.userId, msg.userRole)}`} oncontextmenu={(event) => openUserContextMenu(event, msg.userId)} title={messageUserTitle(msg)} type="button">{displayChatName(msg.username)}</button>
      </div>
    {/if}
    <div class="message-body">
      {#if msg.type === 'system'}
        <p class="message-line system"><span class="message-text-inline">{msg.text}</span></p>
      {:else}
        {#if msg.text}
          <p class="message-line"><span class="message-text-inline">{@html linkify(msg.text)}</span></p>
        {/if}
        {#if msg.text}
          {@const galleryLinks = extractGalleryLinks(msg.text)}
          {#each galleryLinks as link (link.id)}
            {@const preview = getGalleryPreview(link)}
            {#if preview && !preview.missing}
              <a class="gallery-preview-card" href={preview.url} target="_blank" rel="noopener noreferrer">
                {#if preview.nsfw}
                  <span class="gallery-preview-fallback">NSFW</span>
                {:else}
                  <img src={preview.thumbUrl} alt={preview.title} class="gallery-preview-image" loading="lazy" />
                {/if}
                <span class="gallery-preview-copy">
                  <strong>{preview.title}</strong>
                  <span>{preview.author}</span>
                </span>
              </a>
            {/if}
          {/each}
        {/if}
        {#if msg.type === 'image' && msg.imageData}
          <button class="chat-image-card" onclick={() => openImageViewer(msg.imageData)} type="button">
            <img src={msg.imageData} alt="Chat upload" class="chat-image" />
          </button>
        {/if}
      {/if}
    </div>
  </article>
{/snippet}

{#if toasts.length > 0}
  <div class="chat-toasts">
    {#each toasts as toast (toast.id)}
      <button class="chat-toast" onclick={() => openFromToast(toast.id)}>
        <span class="chat-toast-swatch" style="background: {toast.color}"></span>
        <span class="chat-toast-copy">
          <span class="chat-toast-username">{toast.username}</span>
          <span class="chat-toast-message">{toast.message}</span>
        </span>
      </button>
    {/each}
  </div>
{/if}

<svelte:window onkeydown={handleHudKeydown} />

{#if expandedImage}
  <button class="chat-image-viewer" onclick={closeImageViewer} type="button" aria-label="Close image viewer">
    <div class="chat-image-viewer-frame">
      <img src={expandedImage} alt="Expanded chat upload" class="chat-image-viewer-image" />
    </div>
  </button>
{/if}

{#if deleteMenu}
  <div class="delete-msg-backdrop" onclick={closeDeleteMenu} oncontextmenu={(event) => { event.preventDefault(); closeDeleteMenu(); }} role="presentation"></div>
  <div class="delete-msg-menu" style="left: {deleteMenu.x}px; top: {deleteMenu.y}px;">
    <button class="delete-msg-btn" onclick={confirmDeleteMessage} type="button" title="Delete message" aria-label="Delete message">
      <span aria-hidden="true">✕</span> Delete Message
    </button>
  </div>
{/if}

{#if spamWarning}
  <div class="spam-warning-backdrop" role="presentation">
    <div class="spam-warning-card">
      {#if spamWarning.level >= 3}
        <h3>You've been silenced</h3>
        <p>You sent messages too quickly too many times, so you can no longer chat until a moderator lifts it.</p>
        <button class="spam-warning-btn" onclick={acknowledgeSpamWarning} type="button">OK</button>
      {:else if !spamWarning.acknowledged}
        <h3>Slow down</h3>
        <p>You're sending messages too fast. Wait {Math.ceil(spamCooldownRemainingMs / 1000)}s before sending another, or you'll be silenced.</p>
        <button class="spam-warning-btn" onclick={acknowledgeSpamWarning} type="button">I understand</button>
      {:else}
        <h3>Please wait</h3>
        <p>{Math.ceil(spamCooldownRemainingMs / 1000)}s remaining before you can send another message.</p>
      {/if}
    </div>
  </div>
{/if}

{#if visible}
  <div
    class="chat-shell"
    class:dragging={isDragging}
    class:resizing={isResizing}
    class:popout={isPopout}
    class:desktop-popout={isPopout && isDesktopClient}
    class:mini={effectiveChatMode === 'mini'}
    class:full={effectiveChatMode === 'full'}
    class:hud={!isPopout}
    class:awake={hudAwake}
    class:peek={isPeekCollapsed}
    class:quiet={peekQuiet}
    class:pinned={hudPinned}
    bind:this={chatEl}
    onclick={handleChatLinkClick}
    onpointerenter={expandHudOnHover}
    onpointerdown={expandHud}
    onpointerleave={() => scheduleCollapseHud()}
    onfocusin={expandHud}
    role="presentation"
  >
    {#if isPopout}
      <WindowTitleBar
        title="Chat"
        subtitle=""
        branded={true}
        draggable={false}
        tauriDragRegion={isDesktopClient}
        showModeToggle={false}
        mode={effectiveChatMode}
        showWindowControls={isDesktopClient}
        showCloseButton={false}
        className="chat-titlebar"
      />
    {/if}

    <!-- Ambient HUD bar: channel nav + window controls in one line, and the
         drag handle now that there is no titlebar to grab. -->
    <nav class="hud-bar" onmousedown={startDrag} ontouchstart={startDrag} role="presentation" aria-label="Chat channels">
      <span class="hud-dot" aria-hidden="true"></span>

      <div class="hud-tabs">
        <button class="hud-tab" class:on={activeView === 'all'} onclick={showPublic} title="Public" type="button">Public</button>

        {#if canAccessStaff}
          <button class="hud-tab" class:on={activeView === 'staff'} onclick={showStaff} title="Staff" type="button">Staff</button>
        {/if}

        {#each activeThreads as thread (thread.id)}
          <button class="hud-tab" class:on={activeView === 'dm' && Number(recipient?.id) === Number(thread.id)} class:inactive={thread.user?.afk} onclick={() => openThreadById(thread.id)} title={thread.user?.username || 'Direct message'} type="button">
            {thread.user?.username || 'Unknown'}
            {#if getUnreadCount(thread.id) > 0}
              <span class="hud-count">{getUnreadCount(thread.id)}</span>
            {/if}
          </button>
        {/each}

        <button class="hud-tab hud-new" class:on={activeView === 'directory'} onclick={showDirectory} title="Start direct message" aria-label="Start direct message" type="button">+</button>
      </div>

      <div class="hud-controls">
        <div class="titlebar-sfx" title="SFX volume">
          <button
            class="titlebar-btn sfx-mute-btn"
            class:muted={getSfxVolume() <= 0}
            onclick={toggleSfxMute}
            title={getSfxVolume() > 0 ? 'Mute SFX' : 'Unmute SFX'}
            aria-label={getSfxVolume() > 0 ? 'Mute SFX' : 'Unmute SFX'}
            aria-pressed={getSfxVolume() <= 0}
            type="button"
          >
            <svg class="sfx-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 9.5v5h3.4l4.6 3.8V5.7L7.4 9.5H4z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              {#if getSfxVolume() <= 0}
                <path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              {:else}
                <path d="M15.4 9.6a3.6 3.6 0 0 1 0 4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                {#if getSfxVolume() >= 0.5}
                  <path d="M18 7.2a7 7 0 0 1 0 9.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity="0.85"/>
                {/if}
              {/if}
            </svg>
          </button>
          <input
            class="sfx-slider"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={getSfxVolume()}
            oninput={handleSfxSliderInput}
            aria-label="SFX volume"
            title="SFX volume — {Math.round(getSfxVolume() * 100)}%"
            style="--sfx-fill: {Math.round(getSfxVolume() * 100)}%"
          />
        </div>

        <button class="hud-btn" onclick={() => appState.ranksDialogVisible = true} title="View ranks and their abilities" type="button">Ranks</button>

        {#if !isPopout}
          <button class="hud-btn hud-pin" class:on={hudPinned} onclick={toggleHudPin} title={hudPinned ? 'Let chat collapse again' : 'Keep chat open'} aria-label={hudPinned ? 'Let chat collapse again' : 'Keep chat open'} aria-pressed={hudPinned} type="button"><span class="hud-pin-icon" aria-hidden="true"></span></button>
        {/if}

        {#if !isPopout && isDesktopClient}
          <button class="hud-btn" onclick={popoutChat} title="Open chat in a separate window" aria-label="Pop out chat" type="button">⧉</button>
        {/if}

        {#if !isPopout}
          <button class="hud-btn hud-close" onclick={hide} title="Close chat" aria-label="Close chat" type="button">✕</button>
        {/if}
      </div>
    </nav>

    <header class="chat-topbar" data-refactor-placeholder="true" style="display: none;" onmousedown={startDrag} ontouchstart={startDrag} role="presentation" aria-label="Chat window header" data-tauri-drag-region={isPopout && isDesktopClient ? 'true' : undefined}>
      <div class="chat-topbar-copy">
        {#if isPopout && isDesktopClient}
          <div class="chat-wordmark-wrap" data-tauri-drag-region="true">
            <div class="chat-wordmark-copy" data-tauri-drag-region="true">
              <p class="chat-kicker">DDraw!</p>
              <span>{activeHeaderTitle()}{#if activeHeaderSubtitle()} • {activeHeaderSubtitle()}{/if}</span>
            </div>
          </div>
        {:else}
          <p class="chat-kicker">{activeHeaderTitle()}</p>
          {#if activeHeaderSubtitle()}
            <span>{activeHeaderSubtitle()}</span>
          {/if}
        {/if}
      </div>

      <div class="chat-topbar-actions">
        {#if !isPopout && isDesktopClient}
          <button class="topbar-btn" onclick={popoutChat} title="Open chat in a separate window" type="button">
            Pop Out
          </button>
        {/if}
        {#if isPopout && isDesktopClient}
          <button class="topbar-btn chrome-btn" onclick={minimizeDesktopWindow} title="Minimize chat" type="button">_</button>
          <button class="topbar-btn chrome-btn" onclick={toggleMaximizeDesktopWindow} title={desktopWindowState.maximized ? 'Restore window' : 'Maximize window'} type="button">
            {desktopWindowState.maximized ? '❐' : '□'}
          </button>
          <button class="topbar-btn chrome-btn" onclick={toggleFullscreenDesktopWindow} title={desktopWindowState.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} type="button">
            {desktopWindowState.fullscreen ? '🡼' : '⛶'}
          </button>
        {/if}
        <button class="topbar-btn" onclick={() => appState.ranksDialogVisible = true} title="View ranks and their abilities" type="button">Ranks</button>
        <button class="topbar-btn close" onclick={hide} title="Close chat" type="button">X</button>
      </div>
    </header>

    <div class="chat-content">
      <div class="chat-main">
        <div class="chat-stage" class:drop-target={isDropTarget} ondragenter={handleDragEnter} ondragover={handleDragOver} ondragleave={handleDragLeave} ondrop={handleDrop} role="region" aria-label="Chat messages">
          {#if (activeView === 'all' && !chatPinnedToBottom.all) || (activeView === 'staff' && !chatPinnedToBottom.staff) || (activeView === 'dm' && !chatPinnedToBottom.dm)}
            <button class="return-to-present" onclick={jumpToPresent} type="button">
              Return to present
            </button>
          {/if}
          {#if isDropTarget}
            <div class="drop-overlay">Drop an image into chat</div>
        {/if}

        {#if activeView === 'directory'}
          <section class="directory-view">
            <div class="directory-header">
              <h3>Start a private conversation</h3>
            </div>

            <div class="directory-list">
              {#if directoryUsers.length === 0}
                <div class="directory-empty">Nobody else is online right now.</div>
              {:else}
                {#each directoryUsers as user (user.id)}
                  <button class="directory-user" class:inactive={user.afk} onclick={() => selectDMRecipient(user)} oncontextmenu={(event) => openUserContextMenu(event, user.id)} title={directoryUserMeta(user)} type="button">
                    <span class="directory-avatar" style="--avatar-color: {user.color}">
                      <img src={getChatToolIconUrl(user)} alt={getChatToolIconAlt(user)} class="directory-tool-icon" />
                    </span>
                    <span class="directory-copy">
                      <strong>{user.username}</strong>
                      <small>{directoryUserMeta(user)}</small>
                    </span>
                    {#if getUnreadCount(user.id) > 0}
                      <span class="directory-badge">{getUnreadCount(user.id)}</span>
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>
          </section>
        {:else if activeView === 'dm' && recipient}
          <section class="conversation-view">
            <div class="message-stream dm-stream" bind:this={dmMessagesEl} onscroll={(event) => handleMessageScroll('dm', event)} onwheel={markUserScrollActive} ontouchmove={markUserScrollActive}>
              {#if activeDMMessages.length === 0}
                <div class="message-empty">This thread is empty. Say hi.</div>
              {:else}
                {#each activeDMMessages as msg (msg.id)}
                  <article class="dm-bubble-row" class:self={msg.fromSelf}>
                    <div class="dm-bubble">
                      {@render messageContent(msg)}
                      <span>{formatShortTime(msg.timestamp)}</span>
                    </div>
                  </article>
                {/each}
              {/if}
            </div>
          </section>
        {:else if activeView === 'staff'}
          <section class="conversation-view">
            <div class="message-stream" bind:this={publicMessagesEl} onscroll={(event) => handleMessageScroll('staff', event)} onwheel={markUserScrollActive} ontouchmove={markUserScrollActive}>
              {#if messages.staff.length > 0}
                {#each groupedStaffMessages as msg (msg.id)}
                  {@render channelRow(msg, true)}
                {/each}
              {/if}
            </div>
          </section>
        {:else}
          <section class="conversation-view">
            <div class="message-stream" bind:this={publicMessagesEl} onscroll={(event) => handleMessageScroll('all', event)} onwheel={markUserScrollActive} ontouchmove={markUserScrollActive}>
              {#if messages.all.length === 0}
                <div class="message-empty"></div>
              {:else}
                {#each groupedPublicMessages as msg (msg.id)}
                  {@render channelRow(msg, false)}
                {/each}
              {/if}
            </div>
          </section>
        {/if}
        </div>
      </div>
    </div>

    <footer class="chat-composer">
      {#if composerImage || showEmojiPicker}
        <div class="composer-popovers">
          {#if composerImage}
            <div class="composer-preview">
              <img src={composerImage.dataUrl} alt="Upload preview" />
              <div class="composer-preview-copy">
                <strong>{composerImage.name}</strong>
                <span>Ready to send</span>
              </div>
              <button class="composer-preview-remove" onclick={removeComposerImage} type="button">Remove</button>
            </div>
          {/if}

          {#if showEmojiPicker}
            <div class="emoji-picker">
              <div class="emoji-picker-section">
                <span class="reaction-picker-label">Emojis</span>
                <div class="reaction-picker-grid composer-emoji-grid">
                  {#each rankedComposerEmojis() as emoji (emoji)}
                    <button class="emoji-btn" onclick={() => insertEmoji(emoji)} type="button">
                      {emoji}
                    </button>
                  {/each}
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <div class="composer-row">
        <input class="composer-file-input" bind:this={fileInputEl} onchange={handleFileInputChange} accept="image/*" type="file" />
        <button class="composer-tool upload-tool" onclick={openFilePicker} disabled={activeView === 'directory'} title="Upload image" type="button">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M1 1H15V15H1V1ZM6 9L8 11L13 6V13H3V12L6 9ZM6.5 7C7.32843 7 8 6.32843 8 5.5C8 4.67157 7.32843 4 6.5 4C5.67157 4 5 4.67157 5 5.5C5 6.32843 5.67157 7 6.5 7Z" fill="currentColor"/></svg>
        </button>
        <button class="composer-tool emoji-tool" onclick={openEmojiPicker} disabled={activeView === 'directory'} title="Add emoji" type="button">{COMPOSER_EMOJIS[0]}</button>
        <div class="chat-input-wrap">
          <textarea class="chat-input" bind:this={composerInputEl} bind:value={messageInput} onkeydown={handleKeydown} onkeyup={syncMentionSuggestion} onclick={syncMentionSuggestion} oninput={syncMentionSuggestion} placeholder={silenced ? 'You are silenced...' : spamCooldownRemainingMs > 0 ? `Wait ${Math.ceil(spamCooldownRemainingMs / 1000)}s...` : activeView === 'dm' && recipient ? `Message ${recipient.username}...` : activeView === 'directory' ? 'Select someone to start a DM...' : 'Type something...'} rows="1" disabled={activeView === 'directory' || silenced || spamCooldownRemainingMs > 0}></textarea>
          {#if mentionSuggestion}
            <div class="mention-suggestion" aria-live="polite">
              @{mentionSuggestion.username}
            </div>
          {/if}
        </div>
        <button class="chat-send" onclick={handleSend} disabled={activeView === 'directory' || silenced || spamCooldownRemainingMs > 0} type="button" aria-label="Send" title="Send"><img class="chat-send-icon" src="/images/send-arrow.svg" alt="" /></button>
      </div>
    </footer>
    {#if !isPopout}
      <div class="chat-resize-handle edge-n" onmousedown={(event) => startResize(event, 'n')} ontouchstart={(event) => startResize(event, 'n')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle edge-e" onmousedown={(event) => startResize(event, 'e')} ontouchstart={(event) => startResize(event, 'e')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle edge-s" onmousedown={(event) => startResize(event, 's')} ontouchstart={(event) => startResize(event, 's')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle edge-w" onmousedown={(event) => startResize(event, 'w')} ontouchstart={(event) => startResize(event, 'w')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle corner-ne" onmousedown={(event) => startResize(event, 'ne')} ontouchstart={(event) => startResize(event, 'ne')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle corner-nw" onmousedown={(event) => startResize(event, 'nw')} ontouchstart={(event) => startResize(event, 'nw')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle corner-se" onmousedown={(event) => startResize(event, 'se')} ontouchstart={(event) => startResize(event, 'se')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle corner-sw" onmousedown={(event) => startResize(event, 'sw')} ontouchstart={(event) => startResize(event, 'sw')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-grip" class:active={isResizing} onmousedown={(event) => startResize(event, 'se')} ontouchstart={(event) => startResize(event, 'se')} role="presentation" aria-hidden="true" title="Drag to resize">
        <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
          <path d="M13 3L3 13 M13 7L7 13 M13 11L11 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </div>
    {/if}
  </div>
{/if}

<style>
  .titlebar-sfx {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    align-self: stretch;
  }

  .sfx-mute-btn {
    display: grid;
    place-items: center;
    width: 24px;
    min-width: 24px;
    height: 100%;
    align-self: stretch;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-primary);
    opacity: 0.75;
    cursor: pointer;
    transition: opacity 0.15s, background 0.15s, transform 0.15s;
  }

  .sfx-mute-btn:hover {
    background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
    opacity: 1;
    transform: none;
  }

  .sfx-mute-btn.muted {
    color: color-mix(in srgb, #ff8a80 62%, var(--text-primary));
    opacity: 0.9;
  }

  .sfx-icon {
    display: block;
    width: 14px;
    height: 14px;
  }

  .sfx-slider {
    --sfx-fill: 70%;
    --sfx-track: color-mix(in srgb, var(--text-primary) 24%, transparent);
    width: 64px;
    height: 4px;
    margin: 0;
    padding: 0;
    background: linear-gradient(
      to right,
      var(--accent-primary) 0%,
      var(--accent-primary) var(--sfx-fill),
      var(--sfx-track) var(--sfx-fill),
      var(--sfx-track) 100%
    );
    border-radius: 999px;
    outline: none;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    opacity: 0.9;
  }

  .sfx-slider:hover {
    opacity: 1;
  }

  .sfx-slider::-webkit-slider-runnable-track {
    height: 4px;
    background: transparent;
    border-radius: 999px;
  }

  .sfx-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 11px;
    height: 11px;
    margin-top: -3.5px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-primary) 88%, white 12%);
    border: 1px solid color-mix(in srgb, black 30%, transparent);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    transition: transform 0.12s ease;
  }

  .sfx-slider:hover::-webkit-slider-thumb,
  .sfx-slider:active::-webkit-slider-thumb {
    transform: scale(1.2);
  }

  .sfx-slider::-moz-range-thumb {
    width: 11px;
    height: 11px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-primary) 88%, white 12%);
    border: 1px solid color-mix(in srgb, black 30%, transparent);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    transition: transform 0.12s ease;
  }

  .sfx-slider:hover::-moz-range-thumb,
  .sfx-slider:active::-moz-range-thumb {
    transform: scale(1.2);
  }

  .sfx-slider:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent-primary) 55%, transparent);
    outline-offset: 3px;
  }

  .sfx-slider::-moz-range-track {
    height: 4px;
    background: transparent;
    border-radius: 999px;
  }

  .sfx-slider::-moz-range-progress {
    height: 4px;
    background: var(--accent-primary);
    border-radius: 999px;
  }

  .chat-shell.mini .sfx-slider {
    width: 44px;
  }

  .chat-shell {
    --chat-bg: color-mix(in srgb, var(--bg-secondary) 94%, black);
    --chat-border: var(--border-subtle);
    --chat-text: var(--text-primary);
    --chat-muted: var(--text-secondary);
    --chat-accent: var(--accent-primary);
    --chat-shadow: var(--shadow-lg);
    --chat-opacity-raw: var(--chat-opacity, 1);
    /* Ambient HUD idle levels, loudest to quietest: names and message text
       never dim at all, timestamps and the channel bar go quiet, and the
       composer nearly disappears until you reach for it. */
    --chat-surface-idle: 0.38;
    --chat-surface-active: 1;
    --chat-message-idle: 1;
    --chat-message-active: 1;
    --chat-meta-idle: 0.5;
    --chat-bar-idle: 0.5;
    --chat-composer-idle: 0.26;
    /* Chat copy takes its own near-white rather than --text-primary. That
       token is #f0f2f5 — hue 210 at 20% saturation — which reads violet over a
       warm or busy board. Snow is neutral at full brightness. */
    --chat-ink: #fbfbfb;
    /* Widths of the message stream's clock and name gutters — see .message-row.
       The name gutter is sized to comfortably hold CHAT_NAME_DISPLAY_MAX
       (14) characters of the bold 0.9rem name label without triggering the
       fallback CSS truncation. */
    --chat-time-col: 32px;
    --chat-name-col: 108px;
    position: fixed;
    right: 18px;
    bottom: 22px;
    /* Above the floating palettes (#floatingPaletteMount, 1480) and the mini
       colour picker (#dockablePanelOverlayMount, 1490) — an open chat window
       owns that corner of the board and must not be covered by them. */
    z-index: 1500;
    display: flex;
    flex-direction: column;
    width: min(420px, calc(100vw - 24px));
    height: min(560px, calc(100vh - 110px));
    min-width: 280px;
    min-height: 240px;
    color: var(--chat-text);
    background: transparent;
    border: 0;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: var(--chat-shadow);
    font-family: 'Inter', sans-serif;
    isolation: isolate;
  }

  /* Mobile: the tool rail is hidden while the chat is open (see the
     chat-open-mobile effect), so the window centers in the full viewport.
     Dragging still wins — inline left/top override these defaults. */
  :global(html[data-mobile='true']) .chat-shell:not(.popout) {
    /* Narrower gutters — a phone can't spare 110px of the message column.
       Sized for CHAT_NAME_DISPLAY_MAX_MOBILE (10) characters. */
    --chat-time-col: 30px;
    --chat-name-col: 82px;
    --chat-mobile-w: calc(100vw - 24px);
    --chat-mobile-h: min(540px, calc(100dvh - 170px));
    /* !important: the (max-width: 640px) fallback below forces mini
       geometry with !important; on mobile this sizing must win. left/top
       stay normal so drag's inline styles still override position. */
    width: var(--chat-mobile-w) !important;
    height: var(--chat-mobile-h) !important;
    min-width: 0;
    /* mini mode's max-width/height clamp would shrink the phone layout */
    max-width: none;
    max-height: none;
    right: auto;
    bottom: auto;
    left: calc((100vw - var(--chat-mobile-w)) / 2);
    top: calc((100dvh - var(--chat-mobile-h)) / 2);
  }

  /* Touch ergonomics: a comfortably tall composer, and a 16px input font so
     mobile browsers don't zoom the page on focus. */
  :global(html[data-mobile='true']) .chat-shell:not(.popout) textarea.chat-input {
    min-height: 42px;
    font-size: 16px;
  }

  :global(html[data-mobile='true']) .chat-shell:not(.popout) :global(.chat-titlebar button) {
    min-width: 40px;
    min-height: 34px;
  }

  /* Mobile composer: one flat row — [upload] [emoji] [input] [send] — with
     uniform 44px touch targets. */
  :global(html[data-mobile='true']) .chat-shell:not(.popout) .composer-row {
    grid-template-columns: 44px 44px minmax(0, 1fr) 44px;
    grid-template-rows: auto;
    column-gap: 8px;
    row-gap: 0;
    align-items: center;
  }

  :global(html[data-mobile='true']) .chat-shell:not(.popout) .composer-tool,
  :global(html[data-mobile='true']) .chat-shell:not(.popout) .upload-tool,
  :global(html[data-mobile='true']) .chat-shell:not(.popout) .emoji-tool {
    grid-column: auto;
    grid-row: auto;
    width: 44px;
    height: 44px;
    border-radius: 12px;
  }

  :global(html[data-mobile='true']) .chat-shell:not(.popout) .chat-input-wrap {
    grid-column: auto;
    grid-row: auto;
  }

  :global(html[data-mobile='true']) .chat-shell:not(.popout) .chat-input-wrap .chat-input {
    min-height: 44px;
    height: 44px;
    padding: 0.6rem 0.85rem;
  }

  :global(html[data-mobile='true']) .chat-shell:not(.popout) .chat-send {
    grid-column: auto;
    grid-row: auto;
    width: 44px;
    min-width: 44px;
    height: 44px;
    min-height: 44px;
    padding: 0;
    border-radius: 12px;
  }

  :global(html[data-mobile='true']) .chat-shell:not(.popout) .chat-send-icon {
    width: 28px;
    height: 28px;
  }

  .chat-shell::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--chat-bg);
    border: 1px solid var(--chat-border);
    /* No backdrop-filter. .chat-shell sets `isolation: isolate`, which makes it
       a backdrop root, and this pseudo sits at the bottom of it (z-index: -1) —
       so the filter had nothing to sample but an empty backdrop. It never
       frosted anything; it just forced a composited layer that Chrome washed
       flat grey behind the message area. */
    opacity: var(--chat-opacity-raw);
    pointer-events: none;
  }

  .chat-shell :global(.chat-titlebar) {
    background: color-mix(in srgb, black 15%, transparent);
  }

  .chat-shell :global(.chat-titlebar *) {
    opacity: 1;
  }

  .chat-shell.popout :global(.chat-titlebar) {
    background: color-mix(in srgb, var(--bg-elevated) 56%, #1a1f29);
  }

  .chat-shell.mini :global(.chat-titlebar) {
    min-height: 24px;
  }

  .chat-shell.mini :global(.window-titlebar) {
    padding: 0 0.25rem 0 0.6rem;
    min-height: 24px;
    gap: 0.2rem;
  }

  .chat-shell.mini :global(.titlebar-title),
  .chat-shell.mini :global(.titlebar-brand) {
    font-size: 0.96rem;
    font-weight: 700;
    transform: none;
    line-height: 1;
  }

  .chat-shell.mini :global(.titlebar-subtitle) {
    display: none;
  }

  .chat-shell.mini :global(.titlebar-btn) {
    min-width: 24px;
    padding: 0 0.4rem;
    font-size: 0.56rem;
    min-height: 24px;
  }

  .chat-shell.mini .chat-resize-handle {
    display: none;
  }

  .chat-shell.mini .chat-resize-handle.corner-sw {
    display: block;
    width: 12px;
    height: 12px;
    bottom: 0;
    left: 0;
    cursor: nwse-resize;
    z-index: 20;
  }

  .chat-shell.mini .chat-resize-grip {
    display: none;
  }

  .chat-resize-handle {
    position: absolute;
    z-index: 16;
  }

  .chat-resize-handle.edge-n,
  .chat-resize-handle.edge-s {
    left: 12px;
    right: 12px;
    height: 10px;
  }

  .chat-resize-handle.edge-e,
  .chat-resize-handle.edge-w {
    top: 12px;
    bottom: 12px;
    width: 10px;
  }

  .chat-resize-handle.edge-n {
    top: 0;
    cursor: ns-resize;
  }

  .chat-resize-handle.edge-e {
    right: 0;
    cursor: ew-resize;
  }

  .chat-resize-handle.edge-s {
    bottom: 0;
    cursor: ns-resize;
  }

  .chat-resize-handle.edge-w {
    left: 0;
    cursor: ew-resize;
  }

  .chat-resize-handle.corner-ne,
  .chat-resize-handle.corner-nw,
  .chat-resize-handle.corner-se,
  .chat-resize-handle.corner-sw {
    width: 16px;
    height: 16px;
  }

  .chat-resize-handle.corner-ne {
    top: 0;
    right: 0;
    cursor: nesw-resize;
  }

  .chat-resize-handle.corner-nw {
    top: 0;
    left: 0;
    cursor: nwse-resize;
  }

  .chat-resize-handle.corner-se {
    right: 0;
    bottom: 0;
    cursor: nwse-resize;
  }

  .chat-resize-handle.corner-sw {
    left: 0;
    bottom: 0;
    cursor: nesw-resize;
  }

  .chat-resize-grip {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    color: color-mix(in srgb, var(--text-secondary) 55%, transparent);
    cursor: nwse-resize;
    z-index: 20;
    border-radius: 0 0 10px 0;
    transition: color 0.15s ease, background 0.15s ease;
    user-select: none;
    -webkit-user-select: none;
  }

  .chat-resize-grip:hover,
  .chat-resize-grip.active {
    color: var(--accent-primary);
    background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  }

  .chat-shell.popout .chat-resize-grip {
    display: none;
  }

  .chat-shell.popout .chat-resize-handle {
    display: none;
  }

  .chat-shell.dragging .chat-resize-grip {
    pointer-events: none;
  }

  .chat-shell.popout,
  .chat-shell.popout.full {
    inset: 0;
    width: 100vw;
    height: 100vh;
    min-width: 100vw;
    min-height: 100vh;
    border-radius: 0;
    border: 0;
    box-shadow: none;
    backdrop-filter: none;
  }

  .chat-shell.popout::before {
    opacity: 1;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border: 0;
    box-shadow: none;
    border-radius: 0;
    background: color-mix(in srgb, var(--bg-secondary) 95%, black);
  }

  .chat-shell.full {
    --chat-time-col: 36px;
    --chat-name-col: 108px;
    width: min(880px, calc(100vw - 44px));
    height: min(612px, calc(100vh - 56px));
  }

  .chat-shell.mini {
    --chat-time-col: 26px;
    --chat-name-col: 56px;
    width: min(300px, calc(100vw - 48px));
    height: min(360px, calc(100vh - 80px));
    right: 24px;
    bottom: 24px;
    max-width: 300px;
    max-height: 360px;
  }

  .chat-shell.mini .chat-content {
    min-height: 0;
  }

  .chat-shell.mini .conversation-view,
  .chat-shell.mini .chat-stage {
    display: grid;
    grid-template-rows: 1fr;
    min-height: 0;
  }

  .chat-shell.mini .message-stream {
    padding: 0.3rem 0.35rem;
    gap: 0.15rem;
    min-height: 0;
    overflow-y: auto;
  }

  .chat-shell.mini .message-row {
    gap: 0.3rem;
    padding: 0;
    width: 100%;
    align-items: baseline;
  }

  .chat-shell.mini .message-author {
    font-size: 0.65rem;
    line-height: 1.2;
  }

  .chat-shell.mini .message-time {
    display: block;
    font-size: 0.55rem;
    text-align: left;
  }

  .chat-shell.mini .message-body {
    min-width: 0;
  }

  .chat-shell.mini .message-line {
    margin: 0;
    padding: 0;
    line-height: 1.2;
  }

  .chat-shell.mini .message-user {
    font-size: 0.65rem;
    font-weight: 600;
    padding: 0;
    min-height: auto;
    display: inline;
  }

  .chat-shell.mini .message-text-inline {
    font-size: 0.72rem;
    line-height: 1.2;
  }

  .chat-shell.mini .directory-header {
    padding: 0.4rem 0.5rem !important;
    gap: 0.4rem;
  }

  .chat-shell.mini .directory-header h3 {
    font-size: 0.72rem !important;
  }

  .chat-shell.mini .directory-header p {
    font-size: 0.58rem !important;
    margin-top: 0.1rem;
  }

  .chat-shell.mini .directory-list {
    padding: 0.35rem 0.5rem !important;
    gap: 0.3rem !important;
  }

  .chat-shell.mini .directory-user {
    padding: 0.4rem 0.5rem !important;
    gap: 0.45rem !important;
    border-radius: 10px !important;
  }

  .chat-shell.mini .directory-avatar {
    width: 26px !important;
    height: 26px !important;
    border-radius: 8px !important;
  }

  .chat-shell.mini .directory-tool-icon {
    width: 14px !important;
    height: 14px !important;
  }

  .chat-shell.mini .directory-copy strong {
    font-size: 0.72rem !important;
  }

  .chat-shell.mini .directory-copy small {
    font-size: 0.58rem !important;
    margin-top: 0.05rem !important;
  }

  .chat-shell.mini .directory-empty {
    font-size: 0.65rem !important;
  }

  .chat-shell.mini .message-avatar {
    width: 18px;
    height: 18px;
    min-width: 18px;
    min-height: 18px;
  }

  .chat-shell.mini .dm-bubble {
    padding: 0.4rem 0.6rem !important;
    border-radius: 12px !important;
  }

  .chat-shell.mini .dm-bubble .message-text {
    font-size: 0.72rem !important;
    line-height: 1.2 !important;
  }

  .chat-shell.mini .dm-bubble span {
    font-size: 0.55rem !important;
    margin-top: 0.15rem !important;
  }

  .chat-shell.mini .composer-preview {
    display: none;
  }

  .chat-shell.mini .chat-composer {
    display: grid;
    grid-template-rows: auto;
    padding: 0.3rem;
    gap: 0.25rem;
    min-height: 0;
  }

  .chat-shell.mini .composer-row {
    display: flex !important;
    gap: 0.25rem;
    align-items: center;
    flex-wrap: nowrap;
  }

  .chat-shell.mini .chat-resize-handle.corner-se {
    display: block;
    width: 14px;
    height: 14px;
    bottom: 0;
    right: 0;
    cursor: nwse-resize;
    z-index: 20;
  }

  .chat-shell.mini .composer-row > * {
    flex-shrink: 0;
  }

  .chat-shell.mini .chat-input-wrap {
    flex: 1 !important;
    min-width: 0 !important;
    flex-shrink: 1 !important;
  }

  .chat-shell.mini .chat-input {
    min-height: 26px;
    max-height: 50px;
    padding: 0.3rem 0.4rem;
    font-size: 0.7rem;
    line-height: 1.15;
    border-radius: 8px;
  }

  .chat-shell.mini .composer-tool {
    min-width: 24px;
    width: 24px;
    min-height: 26px;
    height: 26px;
    padding: 0.2rem;
    font-size: 0.6rem;
    border-radius: 6px;
    flex-shrink: 0;
  }

  .chat-shell.mini .composer-tool svg {
    width: 12px;
    height: 12px;
  }

  .chat-shell.mini .chat-send {
    min-width: 24px;
    width: 24px;
    min-height: 26px;
    height: 26px;
    padding: 0;
    font-size: 0.55rem;
    font-weight: 700;
    border-radius: 6px;
    flex-shrink: 0;
  }

  .chat-shell.mini .chat-main {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .chat-shell.mini .chat-stage {
    display: grid;
    grid-template-rows: 1fr;
    min-height: 0;
    overflow: hidden;
  }

  .chat-shell.mini .chat-topbar {
    display: flex;
    gap: 0.4rem;
    padding: 0.4rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .chat-shell.mini .chat-topbar-copy {
    flex: 1;
    min-width: 0;
  }

  .chat-shell.mini .chat-topbar-copy p {
    margin: 0;
    font-size: 0.64rem;
  }

  .chat-shell.mini .chat-topbar-actions {
    display: flex;
    gap: 0.2rem;
  }

  .chat-shell.mini .topbar-btn {
    min-width: 22px;
    width: 22px;
    padding: 0.2rem;
    font-size: 0.55rem;
    min-height: 22px;
    height: 22px;
  }

  .chat-shell.mini .emoji-picker {
    display: none !important;
  }

  .chat-shell.mini .composer-emoji-grid {
    display: none !important;
  }

  .chat-shell.mini .reaction-pills {
    gap: 0.2rem;
    font-size: 0.64rem;
  }

  .chat-shell.mini .reaction-pill {
    min-height: 18px;
    padding: 0 0.25rem;
    font-size: 0.6rem;
  }

  .chat-shell.mini .composer-tool {
    min-width: 24px;
    min-height: 24px;
    padding: 0.2rem;
    font-size: 0.64rem;
  }

  /* ─────────────────────────────────────────────────────────────
     Ambient HUD

     The channel rail and the titlebar are gone: nav, SFX, Ranks, pop-out
     and close all live in one line at the top, which doubles as the drag
     handle. The surface itself sits faded over the canvas and solidifies
     when you hover it, focus anything inside it, or a message lands
     (.awake, set by wakeHud()). Pop-out is a real OS window, so it keeps
     its titlebar and never fades.
     ───────────────────────────────────────────────────────────── */
  .hud-bar {
    position: relative;
    z-index: 6;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 5px 7px 4px 11px;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }

  .chat-shell.dragging .hud-bar {
    cursor: grabbing;
  }

  /* The popout is moved by the OS window, not by dragging the bar. */
  .chat-shell.popout .hud-bar {
    cursor: default;
  }

  .hud-dot {
    flex: 0 0 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-primary);
  }

  .hud-tabs {
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .hud-tabs::-webkit-scrollbar {
    display: none;
  }

  .hud-tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
    max-width: 11ch;
    padding: 3px 9px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--chat-muted);
    font-family: inherit;
    font-size: 0.76rem;
    font-weight: 650;
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    transition: background 0.16s ease, color 0.16s ease;
  }

  .hud-tab:hover {
    background: color-mix(in srgb, var(--accent-primary) 13%, transparent);
    color: var(--chat-text);
  }

  .hud-tab.on {
    background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
    color: var(--chat-text);
  }

  .hud-tab.inactive {
    opacity: 0.62;
  }

  .hud-tab.hud-new {
    padding: 3px 8px;
    font-size: 0.92rem;
    line-height: 1.1;
  }

  .hud-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent-primary);
    color: var(--bg-primary);
    font-size: 0.62rem;
    font-weight: 800;
  }

  .hud-controls {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-left: auto;
    flex: 0 0 auto;
  }

  /* The SFX control moved here from the titlebar, which used to stretch it to
     the bar height — pin it instead so it matches the 24px HUD buttons. */
  .hud-controls .titlebar-sfx {
    align-self: center;
    padding: 0 2px;
  }

  .hud-controls .sfx-mute-btn {
    align-self: center;
    height: 22px;
    color: var(--chat-muted);
  }

  .hud-controls .sfx-mute-btn:hover {
    color: var(--chat-text);
  }

  .hud-controls .sfx-slider {
    width: 54px;
  }

  .hud-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    padding: 0 7px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--chat-muted);
    font-family: inherit;
    font-size: 0.72rem;
    font-weight: 650;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .hud-btn:hover {
    background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
    color: var(--chat-text);
  }

  .hud-close:hover {
    background: color-mix(in srgb, #ff6b5c 26%, transparent);
    color: #ffd8d3;
  }

  .hud-tab:focus-visible,
  .hud-btn:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent-primary) 55%, transparent);
    outline-offset: -2px;
  }

  /* Idle: the whole window recedes so it stops competing with the canvas.
     --chat-opacity-raw is the user's own chat-opacity setting, so this
     dims relative to whatever they picked rather than overriding it. */
  .chat-shell.hud {
    box-shadow: none;
  }

  .chat-shell.hud::before {
    opacity: calc(var(--chat-opacity-raw) * var(--chat-surface-idle));
    visibility: visible;
    transition: opacity 0.3s ease;
  }

  .chat-shell.hud:hover::before,
  .chat-shell.hud:focus-within::before,
  .chat-shell.hud.awake::before,
  .chat-shell.hud.dragging::before,
  .chat-shell.hud.resizing::before {
    opacity: var(--chat-opacity-raw);
  }

  /* Idle tiers, applied per-part rather than to a wrapper: a parent's opacity
     can't be undone by a child, so anything that must stay bright (the names
     and text, the Send button) can't sit inside a faded ancestor. */
  .chat-shell.hud .chat-content {
    opacity: var(--chat-message-idle);
  }

  .chat-shell.hud .message-time {
    opacity: var(--chat-meta-idle);
    transition: opacity 0.3s ease;
  }

  /* The bar morphs between a full-width strip and the collapsed pill, so the
     pill's own properties animate rather than snapping.

     `align-self: center` + `width: 100%` is the open state written the long
     way round: identical to the flex default it replaces, but it means the
     collapse only has to change the width (100% -> fit-content, which
     interpolate-size can carry) instead of also swapping align-self, which is
     a discrete property and made the pill jump from centred to flush-left in
     one frame. min-height joins it for the same reason as the shell's. */
  .chat-shell.hud .hud-bar {
    align-self: center;
    width: 100%;
    opacity: var(--chat-bar-idle);
    background-color: transparent;
    border: 1px solid transparent;
    border-radius: 999px;
    transition: opacity 0.3s ease, background-color 0.28s ease,
      border-color 0.28s ease, box-shadow 0.28s ease, padding 0.28s ease,
      margin 0.28s ease, width 0.3s cubic-bezier(0.32, 0.72, 0, 1),
      min-height 0.3s cubic-bezier(0.32, 0.72, 0, 1);
  }

  /* The field drops its own fill at idle, not just its opacity — otherwise the
     panel behind it goes transparent and the input is left as a dark pill
     sitting on the canvas by itself. */
  .chat-shell.hud .chat-input {
    opacity: var(--chat-composer-idle);
    background: transparent;
    border-color: transparent;
    transition: opacity 0.3s ease, background 0.28s ease, border-color 0.28s ease;
  }

  .chat-shell.hud:hover .message-time,
  .chat-shell.hud:hover .hud-bar,
  .chat-shell.hud:focus-within .message-time,
  .chat-shell.hud:focus-within .hud-bar,
  .chat-shell.hud.awake .message-time,
  .chat-shell.hud.awake .hud-bar {
    opacity: 1;
  }

  .chat-shell.hud:hover .chat-input,
  .chat-shell.hud:focus-within .chat-input,
  .chat-shell.hud.awake .chat-input {
    opacity: 1;
    background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
    border-color: color-mix(in srgb, var(--text-primary) 12%, transparent);
  }

  /* Focus outranks the wake group above (same specificity, declared later), so
     typing still gets the solid field and the accent edge. */
  .chat-shell.hud .chat-input:focus {
    opacity: 1;
    background: color-mix(in srgb, var(--bg-primary) 96%, transparent);
    border-color: color-mix(in srgb, var(--accent-primary) 70%, transparent);
  }

  /* Grouped rows repeat no clock — keep them blank at every wake level. */
  .chat-shell.hud .message-row.grouped .message-time {
    opacity: 0;
  }

  /* No drop shadow on chat copy. In the open window the shell's own surface is
     the backing, so the stream must stay fully transparent — a scrim of its own
     reads as a panel inside the panel. Only the peek stack, which has no
     surface behind it at all, gets a plate. */
  .chat-shell.hud .message-line,
  .chat-shell.hud .message-time,
  .chat-shell.hud .message-text {
    text-shadow: none;
  }

  /* The mirror of the peek plate's own transition below. Without it the plate
     only animated on the way down: dropping .peek handed the stream straight
     back to the open layout, so its width, padding and corners snapped in one
     frame while the shell was still growing around it. */
  .chat-shell.hud .message-stream {
    background: transparent;
    transition: width 0.26s cubic-bezier(0.32, 0.72, 0, 1), background 0.3s ease,
      padding 0.26s cubic-bezier(0.32, 0.72, 0, 1),
      border-radius 0.26s cubic-bezier(0.32, 0.72, 0, 1);
  }

  /* Controls stay out of the way until the window is awake. */
  .chat-shell.hud .hud-controls {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s ease;
  }

  .chat-shell.hud:hover .hud-controls,
  .chat-shell.hud:focus-within .hud-controls,
  .chat-shell.hud.awake .hud-controls {
    opacity: 1;
    pointer-events: auto;
  }

  /* Composer collapses to a single pill; the tools slide back in on wake.
     The negative margin cancels the row gap so nothing shifts sideways.

     The mode rule (.chat-shell.full .chat-composer) paints an opaque
     footer tint and is declared later in this file at equal specificity, so
     the HUD has to name the mode too — otherwise the composer stays a solid
     bar while the surface behind it thins out. */
  .chat-shell.hud .chat-composer,
  .chat-shell.hud.full .chat-composer,
  .chat-shell.hud.mini .chat-composer {
    border-top: 0;
    background: transparent;
  }

  /* Send is the one composer part with a solid fill of its own, so it needs the
     same idle level as the field it sits beside or it reads as a bright accent
     chip floating over a window that has otherwise faded out. */
  .chat-shell.hud .chat-send:not(:disabled) {
    opacity: var(--chat-composer-idle);
    box-shadow: none;
    transition: opacity 0.3s ease, background 0.18s ease, box-shadow 0.28s ease,
      transform 0.18s ease;
  }

  .chat-shell.hud:hover .chat-send:not(:disabled),
  .chat-shell.hud:focus-within .chat-send:not(:disabled),
  .chat-shell.hud.awake .chat-send:not(:disabled) {
    opacity: 1;
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 22%, transparent);
  }

  .chat-shell.hud .chat-input,
  .chat-shell.hud .chat-send,
  .chat-shell.hud .composer-tool {
    border-radius: 999px;
  }

  .chat-shell.hud .composer-tool {
    width: 0;
    min-width: 0;
    padding: 0;
    margin-right: -0.5rem;
    border-width: 0;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
    transition: width 0.18s ease, opacity 0.18s ease, margin 0.18s ease;
  }

  .chat-shell.hud:hover .composer-tool,
  .chat-shell.hud:focus-within .composer-tool,
  .chat-shell.hud.awake .composer-tool {
    width: 46px;
    margin-right: 0;
    border-width: 1px;
    opacity: 1;
    pointer-events: auto;
  }

  /* No hover on touch — the tools must always be reachable there. */
  :global(html[data-mobile='true']) .chat-shell.hud .composer-tool {
    width: 44px;
    margin-right: 0;
    border-width: 1px;
    opacity: 1;
    pointer-events: auto;
  }

  :global(html[data-mobile='true']) .chat-shell.hud .hud-controls {
    opacity: 1;
    pointer-events: auto;
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-shell.hud::before,
    .chat-shell.hud .message-time,
    .chat-shell.hud .hud-bar,
    .chat-shell.hud .chat-input,
    .chat-shell.hud .hud-controls,
    .chat-shell.hud .chat-send,
    .chat-shell.hud .composer-tool {
      transition: none;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     Peek stack (collapsed)

     Resting state for the in-app chat: the panel, the channel bar and the
     composer all melt away and the last three messages sit straight on the
     canvas, oldest faintest. After PEEK_QUIET_MS of silence even those go,
     leaving a single accent dot to aim at. Anything that opens the window
     (hover, tap, focus, a mention) drops the .peek class and the whole thing
     rebuilds itself.
     ───────────────────────────────────────────────────────────── */
  /* Collapse and expand are one continuous motion: the shell's own height
     animates (interpolate-size lets it interpolate to and from `auto`), the
     stream's tail stays pinned to the bottom edge so the visible lines never
     jump, and the composer slides out from under it. */
  .chat-shell.hud {
    interpolate-size: allow-keywords;
    /* min-height and max-height ride the same curve as height, and that is not
       cosmetic. The open window's `min-height: 240px` and the peek's
       `max-height: 42vh` are both hard clamps: flip the class and the used
       height jumps to the new bound on the very first frame, then eases from
       there. That instant jump — ~130px on the way open, ~110px on the way
       closed — was the snap. Animating the bounds alongside the height keeps
       them clear of it for the whole run, so nothing ever clamps mid-flight. */
    transition: height 0.34s cubic-bezier(0.32, 0.72, 0, 1),
      min-height 0.34s cubic-bezier(0.32, 0.72, 0, 1),
      max-height 0.34s cubic-bezier(0.32, 0.72, 0, 1);
  }

  /* A length rather than `none`, so the peek's 42vh has something to
     interpolate against. It matches the ceiling onResize already enforces
     (8px of margin top and bottom), so it clamps nothing that wasn't clamped
     before. Mini keeps its own 360px ceiling. */
  .chat-shell.hud:not(.mini) {
    max-height: calc(100vh - 16px);
  }

  /* A manual drag-resize sets height directly every pointermove — the peek
     collapse transition above must not fight that or the box lags behind
     the cursor like it's on a spring. */
  .chat-shell.hud.resizing {
    transition: none;
  }

  .chat-shell.hud.peek {
    height: auto;
    min-height: 0;
    max-height: 42vh;
    /* The shell keeps its full width, so it must not be a hit target itself —
       only the pill and the lines are, or there'd be an invisible hover trap
       sitting over the canvas. */
    pointer-events: none;
  }

  /* The surface fades rather than switching off: `display: none` popped the
     whole panel — fill, border and all — in and out in one frame while the box
     was still easing, which read as the window snapping open even though its
     height was animating perfectly. `visibility` is what keeps the promise the
     old `display: none` was making (a transparent pseudo still gets a layer,
     and that layer is what showed up as a pale rectangle over the board), so
     it flips only once the fade has finished and the pseudo is out of the
     paint tree at rest. On the way open the delay is 0, so the fill starts
     coming up with the first frame of the growth. */
  .chat-shell.hud.peek::before {
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.24s ease, visibility 0s linear 0.24s;
  }

  /* Nothing in the chat body paints a surface of its own. The shell's ::before
     is the only backing; anything else here reads as a panel inside the panel. */
  .chat-shell.hud .chat-content,
  .chat-shell.hud .chat-main,
  .chat-shell.hud .chat-stage,
  .chat-shell.hud .conversation-view {
    background: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .chat-shell.hud.peek .chat-content,
  .chat-shell.hud.peek .chat-main,
  .chat-shell.hud.peek .chat-stage,
  .chat-shell.hud.peek .conversation-view {
    flex: 0 0 auto;
    height: auto;
    min-height: 0;
    overflow: visible;
    /* `flex: 0 0 auto` frees the height, but .chat-main is a *row* flex item, so
       it also freed the width — the chain shrink-wrapped the longest message's
       max-content size. Every percentage downstream then resolved against that
       runaway width, so the plate never hit a wrap point and ran off past the
       window. Pin the width back to the shell's and let the plate do the
       shrink-wrapping on its own terms. */
    width: 100%;
    min-width: 0;
  }

  /* Peek: no panel at all behind the lines, so the scrim shrink-wraps them and
     becomes the only thing holding them off the canvas. `margin: 0 auto` on a
     fit-content block centres the plate under the pill, so a line wider than
     the pill spreads to both sides of it rather than only to the right. */
  .chat-shell.hud.peek .message-stream {
    flex: 0 0 auto;
    /* Tail pinned to the bottom: as the window shrinks around the surviving
       lines they stay where they were instead of sliding up the container. */
    justify-content: flex-end;
    overflow: hidden;
    /* fit-content is the no-JS fallback; syncPeekPlateWidth pins the same
       number as a pixel value so the width can actually transition. */
    width: var(--peek-plate-w, fit-content);
    max-width: calc(100% - 20px);
    margin: 0 auto;
    padding: 5px 11px 6px;
    border-radius: 9px;
    /* No backdrop-filter here. .chat-shell sets `isolation: isolate`, which
       makes it a backdrop root — a blur inside it can only sample the shell's
       own (empty) content, never the board. It bought nothing, forced a
       composited layer, and left a stale pale rectangle at the old width
       whenever the plate shrank. */
    background: rgba(11, 13, 16, 0.52);
    pointer-events: auto;
    transition: width 0.26s cubic-bezier(0.32, 0.72, 0, 1), background 0.3s ease,
      padding 0.26s cubic-bezier(0.32, 0.72, 0, 1),
      border-radius 0.26s cubic-bezier(0.32, 0.72, 0, 1);
  }

  /* Nothing left to plate once the lines have faded out. */
  .chat-shell.hud.peek.quiet .message-stream {
    background: transparent;
  }

  /* Every line in the stack names its sender: the stack is only three rows
     deep, so a run of messages would otherwise show an anonymous tail. */
  .chat-shell.hud.peek .message-row.grouped .message-user {
    visibility: visible;
  }

  /* Only the tail of the stream, and only while it is fresh. */
  .chat-shell.hud.peek .message-row:not(:nth-last-child(-n + 3)),
  .chat-shell.hud.peek .dm-bubble-row:not(:nth-last-child(-n + 3)) {
    display: none;
  }

  .chat-shell.hud.peek .message-row:nth-last-child(3),
  .chat-shell.hud.peek .dm-bubble-row:nth-last-child(3) {
    opacity: 0.34;
  }

  .chat-shell.hud.peek .message-row:nth-last-child(2),
  .chat-shell.hud.peek .dm-bubble-row:nth-last-child(2) {
    opacity: 0.62;
  }

  .chat-shell.hud.peek .hud-controls,
  .chat-shell.hud.peek .return-to-present {
    opacity: 0;
    pointer-events: none;
  }

  /* No clock in the peek stack, and it leaves the grid entirely rather than
     zeroing its track — a 0-width column still costs its column-gap, which read
     as dead padding down the left edge of the plate. */
  .chat-shell.hud.peek .message-time {
    display: none;
  }

  .chat-shell.hud.peek .message-row {
    grid-template-columns: var(--chat-name-col) minmax(0, 1fr);
    /* max-content, not a measured width: the row then hugs its own single line
       no matter how wide the plate happens to be at that instant, so a short
       message can never be squeezed into two lines by a plate that is still
       animating — or by a --peek-row-w that is one frame stale. The measured
       value is only the ceiling, for messages long enough to genuinely wrap. */
    width: max-content;
    max-width: var(--peek-row-w, 100%);
  }

  /* The plate widens first, then the line arrives — the delay covers the width
     transition, so nothing is ever revealed mid-resize. */
  .chat-shell.hud.peek .message-row:last-child {
    animation: peek-row-in 0.18s ease 0.2s both;
  }

  @keyframes peek-row-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .chat-shell.hud.peek .message-row.system .message-body {
    grid-column: 1 / 3;
  }

  /* An image among the last few lines shouldn't blow the minimized peek
     plate up to full message-view size — cap it to a small thumbnail so it
     stays unobtrusive sitting over the canvas. */
  .chat-shell.hud.peek .chat-image-card {
    max-width: 160px;
  }

  .chat-shell.hud.peek .chat-image {
    max-height: 72px;
  }

  /* The bar becomes a small solid pill holding the dot and the current channel
     — the one thing that is always on screen, so an empty or silent room still
     has something to see and to aim at. It is shrink-wrapped rather than
     full-width, so there's no invisible strip to catch a stray brush stroke. */
  .chat-shell.hud.peek .hud-bar {
    /* Centred rather than flush left: the plate below is centred too, so the
       two share a centre line and the stack grows out symmetrically around the
       pill instead of only ever running off to the right of it. */
    align-self: center;
    width: fit-content;
    min-height: 0;
    height: auto;
    gap: 6px;
    margin: 0 0 4px;
    padding: 3px 10px 3px 9px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-secondary) 90%, black);
    border: 1px solid var(--border-subtle);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    /* Brighter than the bar's normal idle level (--chat-bar-idle): when the
       room is silent this pill is the only thing on screen. */
    opacity: 0.78;
    cursor: pointer;
    pointer-events: auto;
  }

  /* Only the channel you're actually in survives the collapse. */
  .chat-shell.hud.peek .hud-tab:not(.on) {
    display: none;
  }

  .chat-shell.hud.peek .hud-tab.on {
    max-width: 14ch;
    padding: 0;
    background: transparent;
    color: var(--chat-text);
    font-size: 0.7rem;
    /* The whole pill is the target, not the label inside it. */
    pointer-events: none;
  }

  .chat-shell.hud.peek .hud-tabs {
    overflow: visible;
  }

  /* On the way in the composer waits for the panel to establish, then slides
     up; on the way out it leaves first, so you never see a dark input pill
     floating on its own over the canvas. */
  .chat-shell.hud .chat-composer {
    transition: height 0.3s cubic-bezier(0.32, 0.72, 0, 1),
      padding 0.3s cubic-bezier(0.32, 0.72, 0, 1),
      opacity 0.2s ease 0.1s,
      transform 0.28s cubic-bezier(0.32, 0.72, 0, 1) 0.06s;
  }

  .chat-shell.hud.peek .chat-composer {
    height: 0;
    min-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    border: 0;
    opacity: 0;
    overflow: hidden;
    transform: translateY(10px);
    pointer-events: none;
    transition: height 0.3s cubic-bezier(0.32, 0.72, 0, 1),
      padding 0.3s cubic-bezier(0.32, 0.72, 0, 1),
      opacity 0.14s ease,
      transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
  }

  /* Nothing to grab while collapsed — the handles would be invisible traps. */
  .chat-shell.hud.peek .chat-resize-handle,
  .chat-shell.hud.peek .chat-resize-grip {
    display: none;
  }

  /* Quiet room: the lines fade out and the space they held closes with them. */
  .chat-shell.hud.peek .chat-content {
    transition: opacity 0.3s ease, height 0.34s cubic-bezier(0.32, 0.72, 0, 1);
  }

  .chat-shell.hud.peek.quiet .chat-content {
    opacity: 0;
    height: 0;
    overflow: hidden;
    transition: opacity 0.3s ease, height 0.4s cubic-bezier(0.32, 0.72, 0, 1) 0.12s;
  }

  /* The pin is drawn from public/images/pin-icon.svg as a mask rather than an
     <img> so it takes the button's colour (the file's fill is hard-coded). */
  .hud-pin {
    padding: 0 6px;
  }

  .hud-pin-icon {
    display: block;
    width: 13px;
    height: 13px;
    background: currentColor;
    -webkit-mask: url('/images/pin-icon.svg') center / contain no-repeat;
    mask: url('/images/pin-icon.svg') center / contain no-repeat;
    /* The glyph ships tilted 45°, needle down-left. Unpinned leaves it leaning;
       pinning drives it straight in. */
    transform: rotate(0deg);
    transition: transform 0.18s ease;
  }

  .hud-pin.on .hud-pin-icon {
    transform: rotate(-45deg);
  }

  .hud-pin.on {
    background: color-mix(in srgb, var(--accent-primary) 24%, transparent);
    color: var(--chat-text);
  }

  @media (prefers-reduced-motion: reduce) {
    .hud-pin-icon {
      transition: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-shell.hud,
    .chat-shell.hud .chat-composer,
    .chat-shell.hud.peek .chat-composer,
    .chat-shell.hud.peek .chat-content,
    .chat-shell.hud.peek.quiet .chat-content {
      transition: none;
    }

    .chat-shell.hud.peek .chat-composer {
      transform: none;
    }

    .chat-shell.hud .message-stream,
    .chat-shell.hud.peek .message-stream {
      transition: none;
    }

    /* Zero-length rather than `none`: the delay is what keeps the pseudo out of
       the paint tree while collapsed, so it still has to fire — just now. */
    .chat-shell.hud.peek::before {
      transition: opacity 0s, visibility 0s;
    }

    .chat-shell.hud.peek .message-row:last-child {
      animation: none;
    }
  }

  .chat-shell.mini .hud-bar {
    min-height: 26px;
    padding: 3px 4px 2px 8px;
    gap: 4px;
  }

  .chat-shell.mini .hud-tab {
    padding: 2px 7px;
    font-size: 0.64rem;
    max-width: 8ch;
  }

  .chat-shell.mini .hud-btn {
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    font-size: 0.62rem;
  }

  .chat-content {
    display: flex;
    flex-direction: row;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .chat-shell.popout .chat-content {
    height: 100%;
  }

  .topbar-btn,
  .directory-user,
  .return-to-present,
  .chat-send,
  .chat-toast,
  .composer-tool,
  .emoji-btn,
  .reaction-pill,
  .quick-reaction,
  .chat-image-card,
  .composer-preview-remove {
    border: 0;
    cursor: pointer;
  }

  .topbar-btn:hover,
  .directory-user:hover,
  .chat-send:hover,
  .chat-toast:hover,
  .composer-tool:hover,
  .emoji-btn:hover,
  .reaction-pill:hover,
  .quick-reaction:hover,
  .chat-image-card:hover,
  .composer-preview-remove:hover {
    transform: translateY(-1px);
  }

  .directory-user:active,
  .composer-tool:active:not(:disabled),
  .emoji-btn:active:not(:disabled),
  .chat-send:active:not(:disabled),
  .return-to-present:active,
  .composer-preview-remove:active {
    transform: translateY(0) scale(0.985);
  }

  .directory-user:focus-visible,
  .composer-tool:focus-visible,
  .emoji-btn:focus-visible,
  .chat-send:focus-visible,
  .composer-preview-remove:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent-primary) 55%, transparent);
    outline-offset: -2px;
  }

  .directory-avatar {
    background: color-mix(in srgb, var(--avatar-color) 82%, black 18%);
    color: white;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.18);
  }

  .directory-badge {
    display: inline-flex;
    min-width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--accent-primary);
    color: var(--bg-primary);
    font-size: 0.68rem;
    font-weight: 800;
  }

  .chat-main {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    /* .chat-content is a flex row and .chat-main is its only item — without an
       explicit grow it sizes to its content's max-content width instead of
       filling the row, which starves the minmax(0, 1fr) message column and
       leaves the message section short of the window's right edge. */
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    min-height: 0;
    background: transparent;
  }

  .chat-shell.popout .chat-main,
  .chat-shell.popout .chat-stage,
  .chat-shell.popout .conversation-view,
  .chat-shell.popout .directory-view {
    height: 100%;
  }

  .chat-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.7rem 1.15rem;
    border-bottom: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-elevated) 50%, transparent);
    cursor: move;
  }

  .chat-shell.popout .chat-topbar {
    border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    border-radius: 0;
  }

  .chat-topbar-copy {
    min-width: 0;
  }

  .chat-wordmark-wrap {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .chat-wordmark-copy {
    min-width: 0;
  }

  .chat-wordmark-copy .chat-kicker {
    margin: 0;
    font-family: 'Fredoka', sans-serif;
    font-size: 1.35rem;
    font-weight: 700;
    color: #00d4aa;
    transform: rotate(-2deg);
    transform-origin: left center;
    letter-spacing: 0.01em;
  }

  .chat-wordmark-copy span {
    display: block;
    margin-top: 0.18rem;
    color: var(--chat-muted);
    font-size: 0.76rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat-kicker {
    margin: 0.5rem 0 0.25rem;
    color: color-mix(in srgb, var(--accent-primary) 58%, var(--text-primary));
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .chat-topbar-copy span {
    display: inline-block;
    margin-top: 0.1rem;
    color: var(--chat-muted);
    font-size: 0.8rem;
  }

  .chat-topbar-actions {
    display: flex;
    gap: 8px;
    align-self: center;
    margin-top: 0;
  }

  .chat-shell.dragging {
    user-select: none;
  }

  .topbar-btn {
    min-height: 36px;
    padding: 0 0.85rem;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);
    color: var(--chat-text);
    font-size: 0.76rem;
    font-weight: 700;
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .topbar-btn:hover {
    background: color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated));
    color: var(--chat-text);
  }

  .topbar-btn.close {
    width: 36px;
    padding: 0;
  }

  .chrome-btn {
    width: 36px;
    padding: 0;
    font-size: 0.95rem;
  }

  .topbar-btn.close:hover {
    background: color-mix(in srgb, #ff6b6b 22%, var(--bg-elevated));
    color: white;
  }

  .chat-stage {
    position: relative;
    min-height: 0;
    overflow: hidden;
    transition: background 0.18s ease;
  }

  .chat-stage:hover,
  .chat-stage:focus-within,
  .chat-shell.dragging .chat-stage,
  .chat-shell.resizing .chat-stage {
    background: transparent;
  }

  .chat-stage :global(.message-row),
  .chat-stage :global(.message-body),
  .chat-stage :global(.message-line),
  .chat-stage :global(.message-text),
  .chat-stage :global(.message-text-inline),
  .chat-stage :global(.message-user),
  .chat-stage :global(.message-time),
  .chat-stage :global(.dm-bubble),
  .chat-stage :global(.dm-bubble span),
  .chat-stage :global(.message-empty),
  .chat-stage :global(.directory-empty) {
    opacity: 1;
  }

  .chat-stage.drop-target {
    background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
  }

  .chat-stage.drop-target::after {
    content: '';
    position: absolute;
    inset: 8px;
    border: 2px solid color-mix(in srgb, var(--accent-primary) 70%, white 10%);
    border-radius: 18px;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-primary) 24%, transparent);
    pointer-events: none;
  }

  .drop-overlay {
    position: absolute;
    inset: 16px;
    z-index: 5;
    display: grid;
    place-items: center;
    border: 1px dashed color-mix(in srgb, var(--accent-primary) 60%, transparent);
    border-radius: 20px;
    background: color-mix(in srgb, var(--bg-secondary) 84%, transparent);
    color: var(--chat-text);
    font-size: 0.96rem;
    font-weight: 700;
    pointer-events: none;
  }

  .return-to-present {
    position: absolute;
    right: 16px;
    bottom: 16px;
    z-index: 8;
    min-height: 34px;
    padding: 0 0.85rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
    color: var(--chat-text);
    font-family: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    line-height: 1;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.26);
    transition: background 0.16s ease, color 0.16s ease, transform 0.16s ease, border-color 0.16s ease;
  }

  .return-to-present:hover {
    background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated));
    border-color: color-mix(in srgb, var(--accent-primary) 38%, transparent);
    color: var(--chat-text);
    transform: translateY(-1px);
  }

  .return-to-present:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent-primary) 52%, transparent);
    outline-offset: 2px;
  }

  .conversation-view,
  .directory-view {
    display: grid;
    height: 100%;
    min-height: 0;
    background: color-mix(in srgb, var(--bg-elevated) 6%, transparent);
  }

  .directory-view {
    grid-template-rows: auto minmax(0, 1fr);
  }

  .directory-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.95rem 1.15rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    background: color-mix(in srgb, var(--bg-elevated) 32%, transparent);
  }

  .directory-header h3 {
    display: block;
    margin: 0;
    font-size: 0.95rem;
    font-weight: 800;
  }

  .directory-header p {
    display: block;
    margin: 0.18rem 0 0;
    color: var(--chat-muted);
    font-size: 0.76rem;
  }

  .message-stream,
  .directory-list {
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0.8rem 1.15rem 0.9rem;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--text-secondary) 32%, transparent) transparent;
  }

  .message-stream::-webkit-scrollbar,
  .directory-list::-webkit-scrollbar {
    width: 8px;
  }

  .message-stream::-webkit-scrollbar-track,
  .directory-list::-webkit-scrollbar-track {
    background: transparent;
  }

  .message-stream::-webkit-scrollbar-thumb,
  .directory-list::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--text-secondary) 30%, transparent);
    border-radius: 999px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  .message-stream::-webkit-scrollbar-thumb:hover,
  .directory-list::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--accent-primary) 48%, transparent);
    background-clip: padding-box;
  }

  .message-empty,
  .directory-empty {
    display: grid;
    place-items: center;
    min-height: 100%;
    color: var(--chat-muted);
    font-size: 0.86rem;
    text-align: center;
  }

  /* Three columns — clock, name, message — each a fixed-width gutter ahead of
     the text, so every message body starts on the same x regardless of who is
     talking or how long the timestamp reads, and a run of messages from one
     person stays in the message column instead of the follow-ups sliding left
     under the name. */
  .message-row {
    display: grid;
    /* Both gutters are fixed rather than auto: each row is its own grid, so an
       auto clock column would collapse to nothing on grouped rows (which print
       no time) and drag that row's name and text left out of line. */
    grid-template-columns: var(--chat-time-col) var(--chat-name-col) minmax(0, 1fr);
    align-items: baseline;
    gap: 0.45rem;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    border-bottom: 0;
  }

  /* System lines have no author, but the body still starts in the message
     column (3) rather than swallowing the name gutter — otherwise "joined" /
     "left" text would sit to the left of where every other message starts. */
  .message-row.system .message-body {
    grid-column: 3 / 4;
  }

  /* Grouped rows drop the repeated name but keep its cell, so the run stays in
     one column. Hidden rather than removed — see the peek override. */
  .message-row.grouped .message-user {
    visibility: hidden;
  }

  .message-author {
    min-width: 0;
    overflow: hidden;
    color: var(--chat-ink);
    font-size: 0.9rem;
    line-height: 1.32;
    /* Right-aligned so the names hug the message column and the gap between
       the two stays constant however long the name is. */
    text-align: right;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .message-row.grouped {
    padding-top: 0;
    padding-bottom: 0;
  }

  .message-row.group-tail:not(.grouped) {
    margin-bottom: 0.18rem;
  }

  .message-row + .message-row:not(.grouped) {
    margin-top: 0.14rem;
  }

  .message-time {
    color: color-mix(in srgb, var(--chat-ink) 52%, transparent);
    font-size: 0.62rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    white-space: nowrap;
    text-align: left;
    /* The gutter is fixed-width and collapses to 0 in the peek stack — clip
       rather than let the digits spill into the name column. */
    overflow: hidden;
    user-select: none;
  }

  .message-row.grouped .message-time {
    opacity: 0;
    pointer-events: none;
  }

  .message-body {
    position: relative;
    min-width: 0;
    max-width: 100%;
  }

  .message-line {
    display: block;
    margin: 0;
    color: var(--chat-ink);
    font-size: 0.9rem;
    line-height: 1.32;
    word-break: break-word;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }

  .message-line.system {
    color: color-mix(in srgb, var(--text-secondary) 72%, transparent);
    font-style: italic;
    font-size: 0.82rem;
  }

  .message-text-inline {
    display: inline;
  }

  .message-text-inline :global(a) {
    user-select: text;
    -webkit-user-select: text;
  }

  :global(.chat-inline-emoji) {
    display: inline-block;
    font-size: 1.35em;
    line-height: 1;
    vertical-align: -0.08em;
  }

  :global(.chat-inline-emoji-image) {
    width: 1.35em;
    height: 1.35em;
    object-fit: contain;
  }

  .message-content-row {
    display: block;
    min-width: 0;
    max-width: 100%;
  }

  .message-copy {
    flex: 0 1 auto;
    min-width: 0;
    max-width: min(100%, 36rem);
    user-select: text;
    -webkit-user-select: text;
  }

  .message-user {
    display: inline;
    padding: 0;
    margin: 0;
    background: transparent;
    font-family: inherit;
    font-size: inherit;
    font-weight: 700;
    border: 0;
    box-shadow: none;
    cursor: context-menu;
    line-height: inherit;
    text-align: right;
    vertical-align: baseline;
  }

  .message-user::after {
    content: '';
    display: inline;
    width: 0;
  }

  .message-user.rank-guest {
    color: var(--role-guest);
  }

  /* --role-user is the same #f0f2f5 being replaced, so plain users' names
     follow the ink rather than staying behind at the old cool white. */
  .message-user.rank-user {
    color: var(--chat-ink);
  }

  .message-user.rank-trusted {
    color: var(--role-trusted);
  }

  .message-user.rank-helper {
    color: var(--role-helper);
  }

  .message-user.rank-mod {
    color: var(--role-mod);
  }

  .message-user.rank-admin {
    color: var(--role-admin);
  }

  .message-user.rank-noble {
    color: var(--role-noble);
    text-shadow: 0 0 6px color-mix(in srgb, var(--role-noble), transparent 65%);
  }

  .message-user.rank-holy {
    color: var(--role-holy);
    text-shadow: 0 0 7px color-mix(in srgb, var(--role-holy), transparent 62%);
  }

  .message-user.rank-deity {
    color: var(--role-deity);
    text-shadow: 0 0 7px color-mix(in srgb, var(--role-deity), transparent 58%);
  }

  :global(.message-mention) {
    font-weight: 700;
    letter-spacing: 0.01em;
  }

  :global(.message-mention.rank-guest) {
    color: var(--role-guest);
  }

  :global(.message-mention.rank-user) {
    color: var(--role-user);
  }

  :global(.message-mention.rank-trusted) {
    color: var(--role-trusted);
  }

  :global(.message-mention.rank-helper) {
    color: var(--role-helper);
  }

  :global(.message-mention.rank-mod) {
    color: var(--role-mod);
  }

  :global(.message-mention.rank-admin) {
    color: var(--role-admin);
  }

  :global(.message-mention.rank-noble) {
    color: var(--role-noble);
    text-shadow: 0 0 6px color-mix(in srgb, var(--role-noble), transparent 65%);
  }

  :global(.message-mention.rank-holy) {
    color: var(--role-holy);
    text-shadow: 0 0 7px color-mix(in srgb, var(--role-holy), transparent 62%);
  }

  :global(.message-mention.rank-deity) {
    color: var(--role-deity);
    text-shadow: 0 0 7px color-mix(in srgb, var(--role-deity), transparent 58%);
  }

  .message-text {
    margin: 0 0 0;
    color: var(--chat-ink);
    font-size: 0.9rem;
    line-height: 1.32;
    word-break: break-word;
    user-select: text;
    -webkit-user-select: text;
  }

  .message-row.grouped .message-text,
  .message-row.grouped .message-line {
    margin-top: 0;
  }

  .chat-image-card {
    display: block;
    max-width: min(100%, 360px);
    margin: 0.18rem 0 0;
    padding: 0;
    overflow: hidden;
    border-radius: 18px;
    background: color-mix(in srgb, var(--bg-elevated) 68%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
  }

  .chat-image {
    display: block;
    width: 100%;
    max-height: 260px;
    object-fit: cover;
  }

  .gallery-preview-card {
    display: grid;
    grid-template-columns: 82px minmax(0, 1fr);
    align-items: center;
    width: min(100%, 340px);
    min-height: 68px;
    margin: 0.4rem 0 0;
    overflow: hidden;
    color: var(--chat-text);
    text-decoration: none;
    border: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 7%, transparent);
  }

  .gallery-preview-card:hover {
    border-color: color-mix(in srgb, var(--accent-primary) 44%, var(--border-subtle));
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
  }

  .gallery-preview-image,
  .gallery-preview-fallback {
    width: 82px;
    height: 68px;
  }

  .gallery-preview-image {
    display: block;
    object-fit: cover;
    background: color-mix(in srgb, var(--bg-secondary) 80%, black);
  }

  .gallery-preview-fallback {
    display: grid;
    place-items: center;
    color: var(--chat-muted);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    background: color-mix(in srgb, var(--bg-secondary) 78%, black);
  }

  .gallery-preview-copy {
    display: grid;
    gap: 0.18rem;
    min-width: 0;
    padding: 0.55rem 0.65rem;
  }

  .gallery-preview-copy strong,
  .gallery-preview-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gallery-preview-copy strong {
    color: var(--chat-text);
    font-size: 0.84rem;
    line-height: 1.2;
  }

  .gallery-preview-copy span {
    color: var(--chat-muted);
    font-size: 0.74rem;
  }


  .emoji-picker {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    /* Narrow popover anchored over the emoji button: ~6 emojis per row,
       overflow scrolls vertically. */
    width: min(248px, 100%);
    align-self: flex-start;
    padding: 0.6rem;
    border: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--bg-secondary) 96%, black);
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.32),
      inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
  }

  .emoji-picker-section {
    display: flex;
    flex-direction: column;
    gap: 0.24rem;
  }

  .reaction-picker-label {
    color: var(--chat-muted);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .reaction-picker-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    padding-left: 0.1rem;
  }

  .composer-emoji-grid {
    max-height: 164px;
    overflow-y: auto;
    padding-top: 0.1rem;
    padding-right: 0.1rem;
  }

  .emoji-picker .emoji-btn {
    display: grid;
    place-items: center;
    min-width: 32px;
    min-height: 32px;
    padding: 0;
    border-radius: 12px;
    font-size: 1.08rem;
    line-height: 1;
    background: color-mix(in srgb, var(--bg-secondary) 64%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 74%, transparent);
  }

  .emoji-picker .emoji-btn:hover {
    background: color-mix(in srgb, var(--accent-primary) 15%, var(--bg-secondary));
    border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
  }

  .dm-stream {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .dm-bubble-row {
    display: flex;
  }

  .dm-bubble-row.self {
    justify-content: flex-end;
  }

  .dm-bubble {
    position: relative;
    max-width: min(78%, 540px);
    padding: 0.62rem 0.78rem 0.58rem;
    border-radius: 18px 18px 18px 6px;
    background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
    user-select: text;
    -webkit-user-select: text;
  }

  .dm-bubble-row.self .dm-bubble {
    border-radius: 18px 18px 6px 18px;
    background: color-mix(in srgb, var(--accent-primary) 22%, var(--bg-elevated));
    color: var(--chat-text);
  }

  .dm-bubble :global(.message-text) {
    color: inherit;
  }

  .dm-bubble :global(.message-text),
  .dm-bubble :global(.message-row.grouped .message-text) {
    line-height: 1.14;
  }

  .message-row.grouped {
    padding-top: 0;
    padding-bottom: 0;
  }

  .message-row.grouped .message-body {
    padding-top: 0;
    padding-bottom: 0;
  }

  .message-row.grouped .reaction-row {
    margin-top: 0.12rem;
  }

  .dm-bubble span {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.7rem;
    color: color-mix(in srgb, var(--text-secondary) 68%, transparent);
    white-space: nowrap;
  }

  .dm-bubble :global(a),
  .message-copy :global(a) {
    user-select: text;
    -webkit-user-select: text;
  }

  .dm-bubble-row.self .dm-bubble span {
    color: color-mix(in srgb, var(--text-secondary) 68%, transparent);
  }

  .directory-list {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .directory-user {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    width: 100%;
    padding: 0.8rem 0.9rem;
    border-radius: 16px;
    background: color-mix(in srgb, var(--bg-elevated) 55%, transparent);
    border: 1px solid transparent;
    color: var(--chat-text);
    text-align: left;
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
  }

  .directory-user:hover {
    border-color: color-mix(in srgb, var(--accent-primary) 34%, transparent);
  }

  .directory-user.inactive {
    background: color-mix(in srgb, var(--bg-elevated) 38%, transparent);
    color: color-mix(in srgb, var(--chat-muted) 76%, var(--chat-text) 24%);
  }

  .directory-user.inactive .directory-avatar {
    background: color-mix(in srgb, var(--chat-muted) 46%, var(--bg-secondary) 54%);
  }

  .directory-avatar {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 1rem;
    font-weight: 800;
    flex-shrink: 0;
  }

  .directory-tool-icon {
    width: 22px;
    height: 22px;
    object-fit: contain;
    opacity: 0.95;
    filter: brightness(0) invert(1);
  }

  .directory-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .directory-copy strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.92rem;
  }

  .directory-copy small {
    margin-top: 0.18rem;
    color: var(--chat-muted);
    font-size: 0.74rem;
  }

  .directory-user.inactive .directory-copy small {
    color: color-mix(in srgb, var(--chat-muted) 86%, transparent);
  }

  .chat-composer {
    position: relative;
    /* Above .chat-main so the floating popovers render over the message
       stream, not behind it. */
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
    padding: 1rem 1.15rem 1.1rem;
    border-top: 1px solid var(--border-subtle);
    background: color-mix(in srgb, black 10%, transparent);
    flex: 0 0 auto;
  }

  /* Image preview + emoji picker float above the composer instead of taking
     part in the layout — expanding them must not push the stream around. */
  .composer-popovers {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: calc(100% + 8px);
    z-index: 12;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
  }

  .composer-popovers > * {
    pointer-events: auto;
  }

  .chat-shell.full .chat-composer {
    padding: 0.8rem 0.85rem 0.9rem;
    background: color-mix(in srgb, var(--bg-secondary) 88%, black 6%);
  }

  .composer-row {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: end;
  }

  .composer-file-input {
    display: none;
  }

  /* 46px square to match .chat-input's min-height and .chat-send, so the whole
     composer row lines up on one baseline. */
  .composer-tool {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent);
    color: var(--chat-text);
    font-size: 1rem;
    font-weight: 800;
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
  }

  .composer-tool:hover {
    background: color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated));
    border-color: color-mix(in srgb, var(--accent-primary) 42%, transparent);
    color: var(--chat-text);
  }

  .composer-tool:disabled,
  .composer-preview-remove:disabled,
  .emoji-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none;
  }

  .composer-preview {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--border-subtle) 90%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--bg-secondary) 94%, black);
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.32);
  }

  .composer-preview img {
    width: 56px;
    height: 56px;
    border-radius: 12px;
    object-fit: cover;
  }

  .composer-preview-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .composer-preview-copy strong,
  .composer-preview-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-preview-copy strong {
    font-size: 0.84rem;
  }

  .composer-preview-copy span {
    color: var(--chat-muted);
    font-size: 0.74rem;
  }

  .composer-preview-remove {
    min-height: 34px;
    padding: 0 0.8rem;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-secondary) 72%, transparent);
    color: var(--chat-text);
    font-size: 0.76rem;
    font-weight: 700;
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .composer-preview-remove:hover {
    background: color-mix(in srgb, #ff6b6b 22%, var(--bg-secondary));
    color: white;
  }

  .emoji-picker .emoji-btn {
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .emoji-btn {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
    font-size: 1rem;
  }

  /* Flex + a block textarea: as an inline-block the textarea sat on a text
     baseline, leaving descender space under it that pushed the box a few px
     above the 46px tool/send buttons in the bottom-aligned composer row. */
  .chat-input-wrap {
    position: relative;
    display: flex;
    min-width: 0;
  }

  .mention-suggestion {
    position: absolute;
    right: 0.9rem;
    bottom: 0.62rem;
    max-width: calc(100% - 1.8rem);
    overflow: hidden;
    color: color-mix(in srgb, var(--text-secondary) 82%, transparent);
    font-size: 0.78rem;
    font-style: italic;
    letter-spacing: 0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
  }

  .chat-input {
    display: block;
    min-height: 46px;
    max-height: 120px;
    padding: 0.78rem 1.05rem;
    border: 1px solid color-mix(in srgb, var(--text-primary) 12%, transparent);
    border-radius: 14px;
    width: 100%;
    /* Near-opaque: the field has to stay a solid place to type even when the
       HUD surface behind it is faded down over the canvas. */
    background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
    color: var(--chat-text);
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.35;
    box-sizing: border-box;
    resize: none;
    outline: none;
  }

  .chat-input {
    transition: border-color 0.16s ease, background 0.16s ease;
  }

  .chat-input::placeholder {
    color: color-mix(in srgb, var(--text-secondary) 62%, transparent);
  }

  .chat-input:hover:not(:disabled):not(:focus) {
    border-color: color-mix(in srgb, var(--text-primary) 22%, transparent);
  }

  /* A 1px accent edge instead of a 3px glow ring. */
  .chat-input:focus {
    border-color: color-mix(in srgb, var(--accent-primary) 70%, transparent);
    background: color-mix(in srgb, var(--bg-primary) 96%, transparent);
  }

  .chat-input:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .chat-send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    min-width: 46px;
    height: 46px;
    min-height: 46px;
    padding: 0;
    border-radius: 14px;
    background: var(--accent-primary);
    color: var(--bg-primary);
    font-size: 0.84rem;
    font-weight: 800;
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 22%, transparent);
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
  }

  .chat-send-icon {
    width: 30px;
    height: 30px;
    display: block;
    /* The glyph's ink sits left of the viewBox centre, so it reads off-centre
       in a square button until it's nudged back. */
    transform: translateX(1.5px);
    pointer-events: none;
  }

  .chat-shell.mini .chat-send-icon {
    width: 18px;
    height: 18px;
  }

  .chat-send:hover {
    background: var(--accent-hover);
    color: var(--bg-primary);
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 28%, transparent);
  }

  .chat-send:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  .chat-toasts {
    position: absolute;
    right: 22px;
    bottom: 22px;
    /* Kept above the chat window (1500) and the palette/picker mounts. */
    z-index: 1510;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    pointer-events: none;
  }

  .chat-toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 220px;
    max-width: 320px;
    padding: 0.8rem 0.9rem;
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-secondary) 94%, black);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    color: var(--chat-text);
    box-shadow: var(--shadow-lg);
  }

  .chat-toast:hover {
    border-color: color-mix(in srgb, var(--accent-primary) 38%, transparent);
  }

  .chat-toast-swatch {
    width: 10px;
    height: 40px;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .chat-toast-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 0.12rem;
  }

  .chat-toast-username {
    font-size: 0.82rem;
    font-weight: 800;
  }

  .chat-toast-message {
    overflow: hidden;
    color: var(--chat-muted);
    font-size: 0.76rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-image-viewer {
    position: fixed;
    inset: 0;
    /* Full-screen viewer: above the chat window and everything it stacks over. */
    z-index: 1520;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.72);
    border: 0;
    cursor: zoom-out;
  }

  .chat-image-viewer-frame {
    max-width: min(92vw, 1200px);
    max-height: min(88vh, 900px);
    padding: 10px;
    border-radius: 18px;
    background: color-mix(in srgb, var(--bg-secondary) 92%, black);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
  }

  .chat-image-viewer-image {
    display: block;
    max-width: min(88vw, 1120px);
    max-height: min(84vh, 820px);
    border-radius: 12px;
    object-fit: contain;
  }

  .delete-msg-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1530;
    background: transparent;
    border: 0;
    cursor: default;
  }

  .delete-msg-menu {
    position: fixed;
    z-index: 1531;
    transform: translate(-50%, 8px);
    background: color-mix(in srgb, var(--bg-secondary) 96%, black);
    border: 1px solid color-mix(in srgb, white 12%, transparent);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
    padding: 4px;
  }

  .delete-msg-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: #ff8a80;
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
  }

  .delete-msg-btn:hover {
    background: rgba(239, 68, 68, 0.16);
  }

  .spam-warning-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1540;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.55);
  }

  .spam-warning-card {
    max-width: min(90vw, 340px);
    padding: 20px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-secondary) 96%, black);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
    text-align: center;
  }

  .spam-warning-card h3 {
    margin: 0 0 8px;
    font-size: 15px;
    color: var(--text-primary);
  }

  .spam-warning-card p {
    margin: 0 0 14px;
    font-size: 13px;
    color: color-mix(in srgb, var(--text-primary) 78%, transparent);
    line-height: 1.4;
  }

  .spam-warning-btn {
    padding: 8px 20px;
    border-radius: 8px;
    border: 0;
    background: var(--accent-primary);
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  :global(.chat-link) {
    color: var(--accent-primary);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
  }

  :global(.chat-link:hover) {
    color: var(--accent-hover);
  }

  @media (max-width: 900px) {
    .chat-toasts {
      right: 12px;
      bottom: 12px;
    }

    .chat-shell.full {
      right: 12px;
      bottom: 12px;
      width: calc(100vw - 24px);
      height: min(76vh, 620px);
    }
  }

  @media (max-width: 640px) {
    .chat-toasts {
      right: 8px;
      bottom: 8px;
      left: 8px;
      align-items: stretch;
    }

    .chat-toast {
      min-width: 0;
      max-width: none;
    }

    .chat-shell,
    .chat-shell.full {
      right: 8px;
      bottom: 8px;
      width: calc(100vw - 16px);
      height: calc(100vh - 90px);
      border-radius: 18px;
    }

    .chat-shell.mini {
      width: min(300px, calc(100vw - 48px)) !important;
      height: min(360px, calc(100vh - 80px)) !important;
      right: 24px !important;
      bottom: 24px !important;
    }

    .chat-topbar,
    .directory-header,
    .message-stream,
    .directory-list,
    .chat-composer {
      padding-left: 0.9rem;
      padding-right: 0.9rem;
    }

    .chat-shell.mini .chat-topbar,
    .chat-shell.mini .directory-header,
    .chat-shell.mini .directory-list,
    .chat-shell.mini .chat-composer {
      padding-left: 0.4rem !important;
      padding-right: 0.4rem !important;
    }

    .composer-row {
      grid-template-columns: auto auto minmax(0, 1fr);
    }

    .chat-shell.mini .composer-row {
      display: flex !important;
      gap: 0.25rem !important;
      grid-template-columns: unset !important;
      align-items: center !important;
    }

    .chat-send {
      grid-column: 1 / -1;
    }

    .chat-shell.mini .chat-send {
      grid-column: auto !important;
      min-width: 24px !important;
      width: 24px !important;
      min-height: 26px !important;
      height: 26px !important;
      padding: 0 !important;
      font-size: 0.55rem !important;
      flex-shrink: 0;
    }

    .chat-shell.mini .chat-input-wrap {
      flex: 1;
      min-width: 0;
    }

    .chat-shell.mini .composer-tool {
      min-width: 24px !important;
      width: 24px !important;
      min-height: 26px !important;
      height: 26px !important;
      padding: 0.2rem !important;
      flex-shrink: 0;
    }

    .message-row {
      grid-template-columns: 50px minmax(0, 1fr);
      gap: 0.7rem;
    }

    .chat-shell.mini .message-row {
      grid-template-columns: minmax(0, 1fr) auto !important;
      gap: 0.35rem !important;
      padding: 0 !important;
      width: 100% !important;
      align-items: baseline !important;
    }

    .chat-shell.mini .message-time {
      display: block !important;
      font-size: 0.55rem !important;
    }

    .chat-shell.mini .message-stream {
      padding: 0.4rem 0.5rem !important;
      gap: 0.3rem !important;
      overflow-y: auto !important;
    }

    .chat-shell.mini .chat-input {
      min-height: 28px !important;
      max-height: 60px !important;
      padding: 0.35rem 0.5rem !important;
      font-size: 0.72rem !important;
    }

    .message-content-row {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0.28rem;
    }

    .reaction-row,
    .reaction-pills,
    .reaction-actions {
      align-items: flex-start;
      justify-content: flex-start;
    }

    .topbar-btn {
      min-width: 36px;
      padding: 0 0.72rem;
    }

    .chat-image-card {
      max-width: 100%;
    }

    .dm-bubble {
      max-width: 88%;
    }
  }
</style>
