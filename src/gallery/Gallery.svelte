<script>
  import { onMount, onDestroy } from 'svelte';
  import { ProfileDialog } from '../ui/ProfileDialog.js';
  import TimelapseEditor from './TimelapseEditor.svelte';
  import { ANONYMOUS_AUTHOR } from '../../shared/identity.js';

  // API base URL - defaults to relative (dev proxy) or can be set via env var for production
  const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

  const TOKEN_KEY = 'topDrawAuthToken';
  const USERNAME_KEY = 'topDrawUsername';
  const REMEMBER_ME_KEY = 'topDrawRememberMe'; // shared with the app's Auth.js
  const LAYOUT_KEY = 'topDrawGalleryLayout';
  const HOLY_ROLE = 8;
  const BOARD_COMMENT_PREVIEW = 4;

  // Track if lightbox was opened from a profile (to return to it)
  let openedFromProfile = $state(null);
  let lightboxInstant = $state(false); // Skip fade animation when opening from profile

  // Profile dialog instance
  const profileDialog = new ProfileDialog({
    apiBaseUrl: API_BASE,
    onViewGallery: (username) => {
      filterByAuthor(username);
    },
    onImageClick: (item) => {
      openedFromProfile = item.author;
      lightboxInstant = true;
      openLightbox(item);
    }
  });

  // Gallery state
  let items = $state([]);
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /**
   * The item was uploaded with the username tag off, so `author` is the
   * ANONYMOUS_AUTHOR label rather than a username. Nothing that resolves a name
   * to an account (profile dialog, author filter) may be handed it — an account
   * called "Anonymous" would otherwise inherit every anonymous upload.
   */
  function isAnonymousAuthor(item) {
    return item?.tagUsername === false || item?.author === ANONYMOUS_AUTHOR;
  }

  /** Item has a clip the current viewer is allowed to see (censoring aside). */
  function hasViewableTimelapse(item) {
    return !!item?.animatedUrl && !(isNsfw(item) && !isNsfwRevealed(item));
  }
  /** ...and may be played unattended, i.e. the card hover-loops. */
  function canPlayTimelapse(item) {
    return hasViewableTimelapse(item) && !prefersReducedMotion;
  }
  let loading = $state(true);
  let error = $state(null);
  let page = $state(1);
  let totalPages = $state(1);
  let lightbox = $state(null);
  let likedIds = $state(new Set());
  let sort = $state('newest'); // 'newest' | 'active' | 'top' | 'views'
  let topPeriod = $state('all'); // 'week' | 'month' | 'year' | 'all'
  let authorFilter = $state(null); // username string or null
  let tagFilter = $state(null); // tag string or null
  let showFavorites = $state(false); // viewing favorites mode
  let showLiked = $state(false); // viewing liked images mode
  let favoritedIds = $state(new Set()); // ids user has favorited
  let revealedNsfwIds = $state(new Set());
  let timelapseEditorOpen = $state(false);

  // Layout state: 'grid' or 'board'
  let layout = $state('grid');

  // Board layout per-item state
  let boardCommentsById = $state({});       // { [itemId]: comment[] }  (preview or full)
  let boardCommentCountsById = $state({});  // { [itemId]: number }
  let boardCommentDraftsById = $state({});
  let boardCommentSubmittingById = $state({});
  let boardCommentErrorsById = $state({});
  let boardExpandedThreadIds = $state(new Set()); // item ids whose full thread is loaded
  let boardThreadLoadingIds = $state(new Set());

  // Sidebar state
  let recentCommentsFeed = $state([]);
  let sidebarTags = $state([]);
  let sidebarLoading = $state(false);

  // ── Tag strip fitting ──
  // Collapsed, the strip is a single row: fit as many WHOLE tag chips as the
  // strip width allows, then a "+N more" chip for the rest. Chip metrics below
  // must track the `.tag-strip-list .tag-chip` CSS.
  const TAG_MAX_SHOWN = 12;       // hard cap: only ever the top 12 tags
  const TAG_PREVIEW_FALLBACK = 8; // used until the strip has been measured
  const STRIP_CHIP_FONT = '12.16px Inter, -apple-system, sans-serif'; // 0.76rem
  const STRIP_CHIP_CHROME = 13.24;    // padding 0.32rem * 2 + 1.5px border * 2
  const STRIP_CHIP_INNER_GAP = 5.6;   // gap 0.35rem between #tag and its count
  const STRIP_CHIP_GAP = 7.2;         // list gap 0.45rem
  const STRIP_ROW_SLACK = 2;          // rounding slack so the last chip can't wrap
  let tagsExpanded = $state(false);
  let tagStripWidth = $state(0);

  /**
   * How many tag chips fit on one row of the strip, leaving room for "+N more".
   * @param {{tag: string, count: number}[]} tags
   * @param {number} width  strip content width in px
   * @param {number} _fontVersion  reactivity key only — see tagFontVersion
   * @returns {number}
   */
  function fitStripTags(tags, width, _fontVersion) {
    if (!tags?.length) return 0;
    if (!(width > 0)) return Math.min(tags.length, TAG_PREVIEW_FALLBACK);
    const avail = width - STRIP_ROW_SLACK;

    const chipWidth = (entry) =>
      measureTagText(entry.tag, STRIP_CHIP_FONT)
      + measureTagText(String(entry.count ?? ''), STRIP_CHIP_FONT)
      + STRIP_CHIP_INNER_GAP + STRIP_CHIP_CHROME;

    let used = 0;
    let shown = 0;
    for (const entry of tags) {
      const w = chipWidth(entry) + (shown ? STRIP_CHIP_GAP : 0);
      if (used + w > avail) break;
      used += w;
      shown++;
    }
    if (shown >= tags.length) return tags.length;
    if (!shown) return 1; // always show something, even if it has to overflow

    // Reserve room for the "+N more" chip, dropping tags until it fits.
    while (shown > 1) {
      const expand = measureTagText(`+${tags.length - shown} more`, STRIP_CHIP_FONT)
        + STRIP_CHIP_CHROME + STRIP_CHIP_GAP;
      if (used + expand <= avail) break;
      used -= chipWidth(tags[shown - 1]) + STRIP_CHIP_GAP;
      shown--;
    }
    return shown;
  }

  // ── Card tag row fitting ──
  // The row is a single line: fit as many WHOLE tags as the card width allows,
  // then show "+N" for the rest. Chip metrics below must track the
  // `.card-tags-row .card-tag-chip` CSS.
  const TAG_CHIP_FONT = '10.88px Inter, -apple-system, sans-serif'; // 0.68rem
  const TAG_CHIP_CHROME = 16.4;   // padding 0.45rem * 2 + 1px border * 2
  const TAG_CHIP_GAP = 4.8;       // row gap 0.3rem
  const TAG_ROW_PADDING = 17.6;   // row padding 0.55rem * 2
  let gridEl = $state(null);
  let cardWidth = $state(0);
  let tagFontVersion = $state(0); // bumped once webfonts land so widths re-measure
  let tagMeasureCtx = null;

  function measureTagText(text, font = TAG_CHIP_FONT) {
    if (!tagMeasureCtx) {
      if (typeof document === 'undefined') return text.length * 6;
      tagMeasureCtx = document.createElement('canvas').getContext('2d');
    }
    tagMeasureCtx.font = font;
    return tagMeasureCtx.measureText(text).width;
  }

  let stripTags = $derived(sidebarTags.slice(0, TAG_MAX_SHOWN));
  let tagPreviewCount = $derived(fitStripTags(stripTags, tagStripWidth, tagFontVersion));
  let visibleTags = $derived(tagsExpanded ? stripTags : stripTags.slice(0, tagPreviewCount));


  /**
   * @param {string[]} tags
   * @param {number} width  card width in px
   * @param {number} _fontVersion  reactivity key only — see tagFontVersion
   * @returns {{ shown: string[], hidden: number }}
   */
  function fitTags(tags, width, _fontVersion) {
    if (!tags?.length) return { shown: [], hidden: 0 };
    const avail = width - TAG_ROW_PADDING;
    // Before the grid has been measured, show one tag; it ellipsizes if too long.
    if (!(avail > 0)) return { shown: tags.slice(0, 1), hidden: tags.length - 1 };

    const chipWidth = (tag) => measureTagText(tag) + TAG_CHIP_CHROME;
    const shown = [];
    let used = 0;
    for (const tag of tags) {
      const w = chipWidth(tag) + (shown.length ? TAG_CHIP_GAP : 0);
      if (used + w > avail) break;
      used += w;
      shown.push(tag);
    }
    // Always show something, even if that one tag has to ellipsize.
    if (!shown.length) return { shown: tags.slice(0, 1), hidden: tags.length - 1 };

    let hidden = tags.length - shown.length;
    // Reserve room for the "+N" marker, dropping tags until it fits.
    while (hidden > 0 && shown.length > 1 &&
           used + measureTagText(`+${hidden}`) + TAG_CHIP_GAP > avail) {
      used -= chipWidth(shown.pop()) + TAG_CHIP_GAP;
      hidden = tags.length - shown.length;
    }
    return { shown, hidden };
  }

  // Cards are grid tracks of equal width, so one measurement serves every card.
  $effect(() => {
    if (!gridEl) return;
    const measure = () => {
      const cols = getComputedStyle(gridEl).gridTemplateColumns
        .split(' ').map(parseFloat).filter((n) => !Number.isNaN(n));
      if (cols.length) cardWidth = cols[0];
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(gridEl);
    return () => ro.disconnect();
  });

  // Comments state
  let comments = $state([]);
  let commentsLoading = $state(false);
  let newComment = $state('');
  let commentSubmitting = $state(false);
  let editingCommentId = $state(null);
  let editingCommentText = $state('');
  let commentActionBusy = $state(false);
  let tagDraft = $state('');
  let tagSaving = $state(false);
  let tagEditorOpen = $state(false);
  let lightboxImageWrap = $state(null);
  let lightboxStage = $state(null);
  let shareCopiedId = $state(null);

  // Auth state
  let user = $state(null); // { username, role, userId }
  let authLoading = $state(false);
  let authError = $state(null);
  let showAuthModal = $state(false);
  let authMode = $state('login'); // 'login' | 'register'
  let authForm = $state({ username: '', password: '', email: '' });
  let discordEnabled = $state(false);
  let discordPopupPoll = null;
  let rememberMe = $state(getRememberMe());

  // "Stay logged in" decides *where* the token lives: localStorage survives the
  // browser closing, sessionStorage dies with the tab. Reads check session
  // first so a tab-scoped login wins over a stale persisted one.
  function getRememberMe() {
    try {
      // Unset means "yes" — the gallery persisted logins before this existed.
      return localStorage.getItem(REMEMBER_ME_KEY) !== 'false';
    } catch {
      return true;
    }
  }

  function readToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  function writeToken(token, username) {
    const [store, other] = rememberMe
      ? [localStorage, sessionStorage]
      : [sessionStorage, localStorage];
    try {
      store.setItem(TOKEN_KEY, token);
      store.setItem(USERNAME_KEY, username);
      // Drop the copy in the other store so the two can never disagree.
      other.removeItem(TOKEN_KEY);
      other.removeItem(USERNAME_KEY);
      localStorage.setItem(REMEMBER_ME_KEY, rememberMe ? 'true' : 'false');
    } catch { /* private mode — the session just won't persist */ }
  }

  function clearToken() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        store.removeItem(TOKEN_KEY);
        store.removeItem(USERNAME_KEY);
      } catch { /* ignore */ }
    }
  }

  function authHeaders(extra = {}) {
    const token = readToken();
    return {
      ...extra,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };
  }

  async function fetchGallery() {
    loading = true;
    error = null;
    try {
      let url = `${API_BASE}/api/gallery?page=${page}&limit=24&sort=${sort}`;
      if (sort === 'top') url += `&period=${topPeriod}`;
      if (authorFilter) url += `&author=${encodeURIComponent(authorFilter)}`;
      if (tagFilter) url += `&tag=${encodeURIComponent(tagFilter)}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      items = data.items;
      syncLikedFromItems(items);
      totalPages = data.pages;
      if (layout === 'board') fetchBoardCommentsForItems(items);
    } catch (e) {
      error = 'Could not load gallery. Try again later.';
    } finally {
      loading = false;
    }
  }

  function setLayout(next) {
    if (next === layout) return;
    layout = next;
    try { localStorage.setItem(LAYOUT_KEY, next); } catch {}
    if (next === 'board') {
      fetchBoardCommentsForItems(items);
    }
  }

  function initialLayoutFromEnv() {
    if (typeof window === 'undefined') return 'grid';
    try {
      const stored = localStorage.getItem(LAYOUT_KEY);
      if (stored === 'grid' || stored === 'board') return stored;
    } catch {}
    // Grid is the default everywhere; board (feed) view is opt-in via the toggle.
    return 'grid';
  }

  async function fetchBoardCommentsForItems(forItems) {
    if (!forItems?.length) return;
    const nextComments = { ...boardCommentsById };
    const nextCounts = { ...boardCommentCountsById };
    await Promise.all(forItems.map(async (item) => {
      // Skip if thread already expanded (full thread loaded)
      if (boardExpandedThreadIds.has(item.id)) return;
      try {
        const res = await fetch(`${API_BASE}/api/gallery/${item.id}/comments`);
        if (!res.ok) return;
        const data = await res.json();
        const list = data.comments || [];
        nextCounts[item.id] = list.length;
        nextComments[item.id] = list.slice(-BOARD_COMMENT_PREVIEW);
      } catch {}
    }));
    boardCommentsById = nextComments;
    boardCommentCountsById = nextCounts;
  }

  function boardCommentCountFor(item) {
    return boardCommentCountsById[item.id] ?? item.commentsCount ?? boardCommentsById[item.id]?.length ?? 0;
  }

  async function expandBoardThread(item) {
    if (boardExpandedThreadIds.has(item.id) || boardThreadLoadingIds.has(item.id)) return;
    boardThreadLoadingIds = new Set([...boardThreadLoadingIds, item.id]);
    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}/comments`);
      if (res.ok) {
        const data = await res.json();
        const list = data.comments || [];
        boardCommentsById = { ...boardCommentsById, [item.id]: list };
        boardCommentCountsById = { ...boardCommentCountsById, [item.id]: list.length };
        boardExpandedThreadIds = new Set([...boardExpandedThreadIds, item.id]);
      }
    } catch {} finally {
      const next = new Set(boardThreadLoadingIds);
      next.delete(item.id);
      boardThreadLoadingIds = next;
    }
  }

  function collapseBoardThread(item) {
    const list = boardCommentsById[item.id] || [];
    boardCommentsById = { ...boardCommentsById, [item.id]: list.slice(-BOARD_COMMENT_PREVIEW) };
    const next = new Set(boardExpandedThreadIds);
    next.delete(item.id);
    boardExpandedThreadIds = next;
  }

  async function submitBoardComment(item) {
    if (!user || boardCommentSubmittingById[item.id]) {
      if (!user) openAuthModal('login');
      return;
    }
    const text = (boardCommentDraftsById[item.id] || '').trim();
    if (!text) return;

    boardCommentSubmittingById = { ...boardCommentSubmittingById, [item.id]: true };
    boardCommentErrorsById = { ...boardCommentErrorsById, [item.id]: null };
    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ text })
      });
      if (!res.ok) throw new Error('comment failed');
      const comment = await res.json();
      const current = boardCommentsById[item.id] || [];
      const nextList = boardExpandedThreadIds.has(item.id)
        ? [...current, comment]
        : [...current, comment].slice(-BOARD_COMMENT_PREVIEW);
      boardCommentsById = { ...boardCommentsById, [item.id]: nextList };
      boardCommentDraftsById = { ...boardCommentDraftsById, [item.id]: '' };
      const nextCount = boardCommentCountFor(item) + 1;
      boardCommentCountsById = { ...boardCommentCountsById, [item.id]: nextCount };
      items = items.map(i => i.id === item.id ? { ...i, commentsCount: nextCount } : i);
    } catch {
      boardCommentErrorsById = { ...boardCommentErrorsById, [item.id]: 'Could not post comment. Try again.' };
    } finally {
      boardCommentSubmittingById = { ...boardCommentSubmittingById, [item.id]: false };
    }
  }

  function shortDate(d) {
    const diff = Date.now() - new Date(d).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const days = Math.floor(h / 24);
    if (days < 7) return `${days}d`;
    return formatDate(d);
  }

  async function fetchSidebar() {
    sidebarLoading = true;
    try {
      let url = `${API_BASE}/api/gallery/sidebar`;
      const params = new URLSearchParams();
      if (authorFilter) params.set('author', authorFilter);
      if (tagFilter) params.set('tag', tagFilter);
      const query = params.toString();
      if (query) url += `?${query}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch sidebar');
      const data = await res.json();
      recentCommentsFeed = data.recentComments || [];
      sidebarTags = data.tags || [];
    } catch {
      recentCommentsFeed = [];
      sidebarTags = [];
    } finally {
      sidebarLoading = false;
    }
  }

  function setSort(newSort) {
    if (sort === newSort) return;
    sort = newSort;
    page = 1;
    fetchGallery();
    fetchSidebar();
  }

  function setTopPeriod(period) {
    if (period === topPeriod) return;
    topPeriod = period;
    if (sort !== 'top') sort = 'top';
    page = 1;
    fetchGallery();
    fetchSidebar();
  }

  function filterByAuthor(username) {
    authorFilter = username;
    tagFilter = null;
    showLiked = false;
    showFavorites = false;
    page = 1;
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', `/gallery/${encodeURIComponent(username)}`);
    }
    fetchGallery();
    fetchSidebar();
  }

  function clearAuthorFilter() {
    authorFilter = null;
    page = 1;
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', '/gallery');
    }
    fetchGallery();
    fetchSidebar();
  }

  function filterByTag(tag) {
    tagFilter = tag;
    showFavorites = false;
    showLiked = false;
    page = 1;
    fetchGallery();
    fetchSidebar();
  }

  function clearTagFilter() {
    tagFilter = null;
    page = 1;
    fetchGallery();
    fetchSidebar();
  }

  async function downloadImage(url, filename) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename || url.split('/').pop() || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('Download failed:', err);
      // Fallback: open in new tab
      window.open(url, '_blank');
    }
  }

  async function fetchFavorites() {
    const token = readToken();
    if (!token) return;

    loading = true;
    error = null;
    try {
      const res = await fetch(`${API_BASE}/api/gallery/favorites?page=${page}&limit=24`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      items = data.items;
      syncLikedFromItems(items);
      totalPages = data.pages;
      // All items in favorites view are favorited
      favoritedIds = new Set(items.map(i => i.id));
    } catch (e) {
      error = 'Could not load favorites.';
    } finally {
      loading = false;
    }
  }

  function toggleFavoritesView() {
    showFavorites = !showFavorites;
    showLiked = false;
    authorFilter = null;
    tagFilter = null;
    page = 1;
    if (showFavorites) {
      fetchFavorites();
      recentCommentsFeed = [];
      sidebarTags = [];
    } else {
      fetchGallery();
      fetchSidebar();
    }
  }

  async function fetchLikedImages() {
    const token = readToken();
    if (!token) return;

    loading = true;
    error = null;
    try {
      const res = await fetch(`${API_BASE}/api/gallery/liked?page=${page}&limit=24`, {
        headers: authHeaders()
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      items = data.items;
      syncLikedFromItems(items);
      totalPages = data.pages;
    } catch {
      error = 'Could not load liked images.';
    } finally {
      loading = false;
    }
  }

  function toggleLikedView() {
    showLiked = !showLiked;
    showFavorites = false;
    authorFilter = null;
    tagFilter = null;
    page = 1;
    if (showLiked) {
      fetchLikedImages();
      recentCommentsFeed = [];
      sidebarTags = [];
    } else {
      fetchGallery();
      fetchSidebar();
    }
  }

  function buildPageList(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const out = [1];
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    if (start > 2) out.push('…');
    for (let p = start; p <= end; p++) out.push(p);
    if (end < total - 1) out.push('…');
    out.push(total);
    return out;
  }

  function goToPage(p) {
    if (p < 1 || p > totalPages || p === page) return;
    page = p;
    fetchCurrentPage();
  }

  let pageList = $derived(buildPageList(page, totalPages));

  function fetchCurrentPage() {
    if (showLiked) return fetchLikedImages();
    if (showFavorites) return fetchFavorites();
    fetchGallery();
    fetchSidebar();
  }

  async function toggleFavorite(item) {
    const token = readToken();
    if (!token || !user) return;

    const wasFavorited = favoritedIds.has(item.id);
    const nextFavoritedIds = new Set(favoritedIds);

    // Optimistic update
    if (wasFavorited) {
      nextFavoritedIds.delete(item.id);
      // Remove from list if viewing favorites
      if (showFavorites) {
        items = items.filter(i => i.id !== item.id);
        // Close lightbox if this item was open
        if (lightbox?.id === item.id) {
          closeLightbox();
        }
      }
    } else {
      nextFavoritedIds.add(item.id);
    }
    favoritedIds = nextFavoritedIds;

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}/favorite`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to update favorite');

      const data = await res.json().catch(() => ({}));
      if (typeof data.favorited === 'boolean') {
        const syncedFavoritedIds = new Set(favoritedIds);
        if (data.favorited) syncedFavoritedIds.add(item.id);
        else syncedFavoritedIds.delete(item.id);
        favoritedIds = syncedFavoritedIds;
      }
    } catch {
      // Revert on error
      const revertedFavoritedIds = new Set(favoritedIds);
      if (wasFavorited) {
        revertedFavoritedIds.add(item.id);
        // Re-add to list if viewing favorites
        if (showFavorites) {
          items = [...items, item];
        }
      } else {
        revertedFavoritedIds.delete(item.id);
      }
      favoritedIds = revertedFavoritedIds;
    }
  }

  async function checkFavorite(id) {
    const token = readToken();
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${id}/favorite`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const nextFavoritedIds = new Set(favoritedIds);
        if (data.favorited) nextFavoritedIds.add(id);
        else nextFavoritedIds.delete(id);
        favoritedIds = nextFavoritedIds;
      }
    } catch {}
  }

  async function fetchComments(galleryId) {
    commentsLoading = true;
    comments = [];
    try {
      const res = await fetch(`${API_BASE}/api/gallery/${galleryId}/comments`);
      if (res.ok) {
        const data = await res.json();
        comments = data.comments || [];
      }
    } catch {}
    commentsLoading = false;
  }

  async function submitComment() {
    if (!lightbox || !newComment.trim() || commentSubmitting) return;
    const token = readToken();
    if (!token) return;

    commentSubmitting = true;
    try {
      const res = await fetch(`${API_BASE}/api/gallery/${lightbox.id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text: newComment.trim() })
      });
      if (res.ok) {
        const comment = await res.json();
        comments = [...comments, { ...comment, edited: !!comment.updatedAt }];
        newComment = '';
        fetchSidebar();
      }
    } catch {}
    commentSubmitting = false;
  }

  function beginCommentEdit(comment) {
    editingCommentId = comment.id;
    editingCommentText = comment.text;
  }

  function cancelCommentEdit() {
    editingCommentId = null;
    editingCommentText = '';
  }

  async function saveCommentEdit(commentId) {
    await checkAuth();
    const token = readToken();
    const nextText = editingCommentText.trim();
    const comment = comments.find((entry) => entry.id === commentId);
    if (!token || !comment || !canEditComment(comment) || !nextText || commentActionBusy) return;

    commentActionBusy = true;
    try {
      const res = await fetch(`${API_BASE}/api/gallery/comments/${commentId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text: nextText })
      });
      if (!res.ok) throw new Error('Failed to update comment');

      const data = await res.json().catch(() => ({}));
      comments = comments.map((entry) => entry.id === commentId ? {
        ...entry,
        text: data.text || nextText,
        edited: true,
        updatedAt: data.updatedAt || new Date().toISOString()
      } : entry);
      cancelCommentEdit();
      fetchSidebar();
    } catch {}
    commentActionBusy = false;
  }

  async function deleteComment(commentId) {
    await checkAuth();
    const comment = comments.find((entry) => entry.id === commentId);
    if (!comment || !canDeleteComment(comment) || commentActionBusy) return;

    const token = readToken();
    if (!token) return;

    commentActionBusy = true;
    try {
      const res = await fetch(`${API_BASE}/api/gallery/comments/${commentId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        comments = comments.filter(c => c.id !== commentId);
        if (editingCommentId === commentId) cancelCommentEdit();
        fetchSidebar();
      }
    } catch {}
    commentActionBusy = false;
  }

  /**
   * Owner of the item. An anonymised item reports `isAuthor` from the server
   * instead — its `author` is the ANONYMOUS_AUTHOR label, so matching on the
   * name would both hide the controls from the real owner and offer them to
   * anyone whose account happens to be called "Anonymous".
   */
  function isOwnItem(item) {
    return !!user && (item?.isAuthor === true || (!isAnonymousAuthor(item) && user.username === item.author));
  }

  function canEditTags(item) {
    return isOwnItem(item) || (!!user && (user.role || 0) >= HOLY_ROLE);
  }

  function canDeleteImage(item) {
    return isOwnItem(item) || (!!user && (user.role || 0) >= HOLY_ROLE);
  }

  function canEditTimelapse(item) {
    return !!item?.animatedUrl && canDeleteImage(item);
  }

  /** Point the lightbox and the grid at the item's new clip URL (or none). */
  function applyTimelapseChange(animatedUrl) {
    if (!lightbox) return;
    const id = lightbox.id;
    resetLapsePlayer();
    lightbox = { ...lightbox, animatedUrl };
    items = items.map((entry) => entry.id === id ? { ...entry, animatedUrl } : entry);
    timelapseEditorOpen = false;
  }

  // --- Lightbox time-lapse player -------------------------------------------
  // Opening an item that has a clip plays the clip; the still is one click away.
  let lapseVideo = $state(null);
  let lapseMode = $state(true);      // showing the clip rather than the finished still
  let lapsePlaying = $state(false);
  let lapseTime = $state(0);
  let lapseDuration = $state(0);
  let lapseFailed = $state(false);   // clip 404'd / codec unsupported — fall back to the still
  let lapseScrubbing = $state(false);
  let lapseProbingDuration = false;

  /** Whether the open item has a playable clip, whichever view is on screen. */
  function lapsePlayerAvailable() {
    return !!lightbox && !lapseFailed && hasViewableTimelapse(lightbox);
  }

  // Only the state — `lapseVideo` belongs to bind:this, and the element survives
  // navigation between two items that both have a clip (only its src changes).
  function resetLapsePlayer() {
    lapseMode = true;
    lapsePlaying = false;
    lapseTime = 0;
    lapseDuration = 0;
    lapseFailed = false;
    lapseScrubbing = false;
    lapseProbingDuration = false;
  }

  function toggleLapsePlay() {
    const v = lapseVideo;
    if (!v) return;
    // Hitting play while looking at the finished still means "show me the clip".
    if (!lapseMode) lapseMode = true;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  /**
   * Swap between the clip and the finished still. The <video> stays mounted so
   * the scrub position survives the round trip — only playback is suspended.
   */
  function toggleLapseMode() {
    lapseMode = !lapseMode;
    const v = lapseVideo;
    if (!v) return;
    if (lapseMode) {
      if (!prefersReducedMotion) v.play().catch(() => {});
    } else {
      v.pause();
    }
  }

  function seekLapse(e) {
    const t = Number(e.currentTarget.value);
    if (!Number.isFinite(t)) return;
    if (!lapseMode) lapseMode = true;   // scrubbing implies you want to watch it
    lapseTime = t;
    if (lapseVideo) lapseVideo.currentTime = t;
  }

  function onLapseMeta() {
    const v = lapseVideo;
    if (!v) return;
    if (Number.isFinite(v.duration) && v.duration > 0) {
      lapseDuration = v.duration;
      // Land back at the start if this resolved via the probe seek below.
      if (lapseProbingDuration) {
        lapseProbingDuration = false;
        v.currentTime = 0;
      }
      return;
    }
    // Some muxed WebMs report an Infinite duration until the browser has
    // scanned to the end. Seeking past the end forces it to resolve, and the
    // resulting durationchange brings us back through here.
    if (lapseProbingDuration) return;
    lapseProbingDuration = true;
    try { v.currentTime = 1e101; } catch { lapseProbingDuration = false; }
  }

  function onLapseTime() {
    // Ignore the element's own updates mid-drag or the thumb fights the pointer.
    if (lapseScrubbing || lapseProbingDuration) return;
    lapseTime = lapseVideo?.currentTime || 0;
  }

  function formatClock(sec) {
    const t = Number.isFinite(sec) && sec > 0 ? sec : 0;
    return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  }

  /** One-click removal, same permission bar as canEditTimelapse but skips the crop editor. */
  async function removeTimelapse(item) {
    if (!canEditTimelapse(item)) return;
    const confirmed = await window.showAppConfirm('Remove the time-lapse from this upload? This cannot be undone.', {
      title: 'Remove time-lapse?',
      confirmLabel: 'Remove',
      danger: true
    });
    if (!confirmed) return;

    const token = readToken();
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}/animation`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        applyTimelapseChange(null);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to remove time-lapse');
      }
    } catch {
      alert('Failed to remove time-lapse');
    }
  }

  function canDeleteComment(comment) {
    return !!user && (user.userId === comment.authorId || (user.role || 0) >= HOLY_ROLE);
  }

  function canEditComment(comment) {
    return !!user && user.userId === comment.authorId;
  }

  function isNsfw(item) {
    return !!item?.tags?.includes('nsfw');
  }

  function isNsfwRevealed(item) {
    return !!item && revealedNsfwIds.has(item.id);
  }

  function revealNsfw(item) {
    if (!item?.id) return;
    revealedNsfwIds = new Set([...revealedNsfwIds, item.id]);
  }

  function getLightboxIndex() {
    if (!lightbox) return -1;
    return items.findIndex((item) => item.id === lightbox.id);
  }

  function canGoPrev() {
    return getLightboxIndex() > 0;
  }

  function canGoNext() {
    const idx = getLightboxIndex();
    return idx !== -1 && idx < items.length - 1;
  }

  async function setActiveLightboxItem(item) {
    timelapseEditorOpen = false;
    resetLapsePlayer();
    lightbox = item;
    syncTagDraft(item);
    comments = [];
    commentsLoading = false;
    cancelCommentEdit();
    document.body.style.overflow = 'hidden';
    await checkAuth();
    if (user) {
      checkFavorite(item.id);
    }
    fetchComments(item.id);
  }

  async function navigateLightbox(direction) {
    const idx = getLightboxIndex();
    if (idx === -1) return;
    const nextIndex = idx + direction;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    await setActiveLightboxItem(items[nextIndex]);
  }

  async function toggleFullscreen() {
    if (!lightboxStage) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await lightboxStage.requestFullscreen();
      }
    } catch {}
  }

  function syncTagDraft(item) {
    tagDraft = (item?.tags || []).join(', ');
    tagEditorOpen = false;
  }

  async function saveTags() {
    await checkAuth();
    if (!lightbox || !canEditTags(lightbox) || tagSaving) return;
    const token = readToken();
    if (!token) return;

    tagSaving = true;
    try {
      const nextTags = tagDraft.split(',').map((tag) => tag.trim()).filter(Boolean);
      const res = await fetch(`${API_BASE}/api/gallery/${lightbox.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ tags: nextTags })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update tags');
      }

      const data = await res.json();
      const updatedLightbox = { ...lightbox, tags: data.tags || [] };
      lightbox = updatedLightbox;
      items = items.map((item) => item.id === lightbox.id ? { ...item, tags: data.tags || [] } : item);
      syncTagDraft(updatedLightbox);
      fetchSidebar();
    } catch (err) {
      alert(err.message || 'Failed to update tags');
    } finally {
      tagSaving = false;
    }
  }

  async function deleteImage(item) {
    await checkAuth();
    if (!canDeleteImage(item)) {
      alert('You are not authorized to delete this image.');
      return;
    }
    const confirmed = await window.showAppConfirm('Are you sure you want to delete this image? This cannot be undone.', {
      title: 'Delete image?',
      confirmLabel: 'Delete',
      danger: true
    });
    if (!confirmed) return;

    const token = readToken();
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        // Remove from items list
        items = items.filter(i => i.id !== item.id);
        // Close lightbox
        closeLightbox();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to delete image');
      }
    } catch {
      alert('Failed to delete image');
    }
  }

  async function checkAuth() {
    const token = readToken();
    if (!token) {
      user = null;
      return null;
    }

    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          user = { username: data.username, role: data.role, userId: data.userId };
          likedIds = new Set(Array.isArray(data.likedGalleryIds) ? data.likedGalleryIds : []);
          return user;
        }
      } else {
        // Token invalid, clear it
        clearToken();
        user = null;
      }
    } catch {}

    return user;
  }

  async function handleLogin() {
    if (authLoading) return;
    authError = null;

    if (!authForm.username || !authForm.password) {
      authError = 'Username and password required';
      return;
    }

    authLoading = true;
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: authForm.username, password: authForm.password })
      });
      const data = await res.json();

      if (data.success) {
        writeToken(data.token, data.username);
        user = { username: data.username, role: data.role, userId: data.userId };
        likedIds = new Set(Array.isArray(data.likedGalleryIds) ? data.likedGalleryIds : []);
        closeAuthModal();
      } else {
        authError = data.error || 'Login failed';
      }
    } catch {
      authError = 'Connection error';
    } finally {
      authLoading = false;
    }
  }

  // ---- Discord OAuth ----------------------------------------------------
  // Mirrors the messenger's popup flow: /start hands back an authorize URL, the
  // callback page posts `ddraw:discord-auth` back to this window.

  async function loadDiscordConfig() {
    try {
      const res = await fetch(`${API_BASE}/api/discord/config`, { cache: 'no-store' });
      if (!res.ok) return;
      const config = await res.json();
      discordEnabled = !!config.oauthEnabled;
    } catch {
      // Silent fail — the Discord button just stays hidden
    }
  }

  async function startDiscordOAuth() {
    if (authLoading) return;
    authError = null;
    authLoading = true;
    try {
      const res = await fetch(`${API_BASE}/api/auth/discord/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'login' })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Discord login failed to start');
      }

      const popup = window.open(
        data.url,
        'ddrawDiscordOAuth',
        'popup=yes,width=520,height=720,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes'
      );

      // Popup blocked — fall back to a full-page redirect. The OAuth callback
      // is hardcoded to return to /go/, so this lands the user in the drawing
      // app (logged in) rather than back here. Same as the messenger does.
      if (!popup) {
        window.location.href = data.url;
        return;
      }

      if (discordPopupPoll) clearInterval(discordPopupPoll);
      discordPopupPoll = window.setInterval(() => {
        if (!popup.closed) return;
        clearInterval(discordPopupPoll);
        discordPopupPoll = null;
        authLoading = false;
      }, 500);
    } catch (err) {
      authError = err.message || 'Discord login failed';
      authLoading = false;
    }
  }

  function handleDiscordMessage(event) {
    if (event.origin !== window.location.origin) return;
    const payload = event.data;
    if (!payload || payload.type !== 'ddraw:discord-auth') return;
    applyDiscordAuth(payload);
  }

  async function applyDiscordAuth(payload) {
    authLoading = false;
    if (discordPopupPoll) {
      clearInterval(discordPopupPoll);
      discordPopupPoll = null;
    }

    if (payload.status !== 'success' || !payload.token || !payload.username) {
      authError = payload.error || 'Discord login failed';
      showAuthModal = true;
      return;
    }

    writeToken(payload.token, payload.username);
    // The payload carries no role/userId, and the gallery gates edit, delete and
    // moderation on both — so resolve the real account off /api/auth/me rather
    // than guessing, which also refreshes likedIds.
    await checkAuth();
    closeAuthModal();
  }

  async function handleRegister() {
    if (authLoading) return;
    authError = null;

    if (!authForm.username || !authForm.password) {
      authError = 'Username and password required';
      return;
    }

    authLoading = true;
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: authForm.username,
          password: authForm.password,
          email: authForm.email || undefined
        })
      });
      const data = await res.json();

      if (data.success) {
        writeToken(data.token, data.username);
        user = { username: data.username, role: data.role, userId: data.userId };
        likedIds = new Set(Array.isArray(data.likedGalleryIds) ? data.likedGalleryIds : []);
        closeAuthModal();
      } else {
        authError = data.error || 'Registration failed';
      }
    } catch {
      authError = 'Connection error';
    } finally {
      authLoading = false;
    }
  }

  function logout() {
    clearToken();
    user = null;
    likedIds = new Set();
    showLiked = false;
  }

  function openAuthModal(mode = 'login') {
    authMode = mode;
    authForm = { username: '', password: '', email: '' };
    authError = null;
    showAuthModal = true;
  }

  function closeAuthModal() {
    showAuthModal = false;
    authForm = { username: '', password: '', email: '' };
    authError = null;
  }

  function persistLikedIds(nextLikedIds) {
    likedIds = nextLikedIds;
  }

  function syncLikedFromItems(nextItems) {
    const nextLikedIds = new Set(likedIds);
    for (const item of nextItems || []) {
      if (item.liked || item.likedByCurrentUser) nextLikedIds.add(item.id);
      else nextLikedIds.delete(item.id);
    }
    likedIds = nextLikedIds;
  }

  function updateLikeCount(itemId, likesCount) {
    items = items.map((entry) => entry.id === itemId ? { ...entry, likesCount } : entry);
    if (lightbox?.id === itemId) {
      lightbox = { ...lightbox, likesCount };
    }
  }

  async function like(item) {
    const token = readToken();
    if (!token || !user) {
      openAuthModal('login');
      return;
    }

    const wasLiked = likedIds.has(item.id);
    const previousLikesCount = item.likesCount || 0;
    const nextLikedIds = new Set(likedIds);
    if (wasLiked) nextLikedIds.delete(item.id);
    else nextLikedIds.add(item.id);

    persistLikedIds(nextLikedIds);
    updateLikeCount(item.id, Math.max(0, previousLikesCount + (wasLiked ? -1 : 1)));

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}/like`, {
        method: 'POST',
        headers: authHeaders()
      });
      if (!res.ok) throw new Error('Failed to update like');

      const data = await res.json().catch(() => ({}));
      const syncedLikedIds = new Set(likedIds);
      if (data.liked) syncedLikedIds.add(item.id);
      else syncedLikedIds.delete(item.id);
      persistLikedIds(syncedLikedIds);
      if (typeof data.likesCount === 'number') {
        updateLikeCount(item.id, data.likesCount);
      }
    } catch {
      const revertedLikedIds = new Set(nextLikedIds);
      if (wasLiked) revertedLikedIds.add(item.id);
      else revertedLikedIds.delete(item.id);
      persistLikedIds(revertedLikedIds);
      updateLikeCount(item.id, previousLikesCount);
    }
  }

  async function openLightbox(item) {
    await setActiveLightboxItem(item);
    updateGalleryUrlForItem(item);
  }

  function closeLightbox() {
    timelapseEditorOpen = false;
    resetLapsePlayer();
    const returnToProfile = openedFromProfile;
    openedFromProfile = null;
    lightboxInstant = false;

    // Open profile FIRST (instant, no fade) so backdrop stays visible
    if (returnToProfile) {
      window.history.replaceState({}, '', `/gallery/${encodeURIComponent(returnToProfile)}`);
      profileDialog.show(returnToProfile, { instant: true });
    }

    // Then close lightbox
    lightbox = null;
    comments = [];
    newComment = '';
    cancelCommentEdit();
    tagDraft = '';

    if (!returnToProfile) {
      document.body.style.overflow = '';
      restoreGalleryUrl(authorFilter ? `/gallery/${encodeURIComponent(authorFilter)}` : '/gallery');
    }
  }

  function closeLightboxFromHistory() {
    timelapseEditorOpen = false;
    resetLapsePlayer();
    openedFromProfile = null;
    lightboxInstant = false;
    lightbox = null;
    comments = [];
    newComment = '';
    cancelCommentEdit();
    tagDraft = '';
    document.body.style.overflow = '';
  }

  function handlePopState() {
    const pathMatch = window.location.pathname.match(/^\/gallery\/([a-f0-9]{24})\/?$/);
    if (pathMatch) {
      openImageById(pathMatch[1]);
    } else if (lightbox) {
      closeLightboxFromHistory();
    } else {
      const profilePathMatch = window.location.pathname.match(/^\/gallery\/([^/?#]+)\/?$/);
      const profileSegment = profilePathMatch ? decodeURIComponent(profilePathMatch[1]) : null;
      authorFilter = profileSegment && profileSegment !== 'grid' ? profileSegment : null;
      page = 1;
      fetchGallery();
      fetchSidebar();
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      if (showAuthModal) closeAuthModal();
      // The time-lapse editor sits on top of the lightbox — Escape dismisses
      // the editor first, leaving the item open behind it.
      else if (timelapseEditorOpen) timelapseEditorOpen = false;
      else closeLightbox();
    }
    // Let fields keep their own keys: arrows must not swap the item out from
    // under a comment being typed or the time-lapse scrubber being nudged.
    const t = e.target;
    if (t instanceof HTMLElement
      && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      return;
    }
    // Arrows swap the lightbox item out from under the editor otherwise.
    if (timelapseEditorOpen) return;
    if (e.key === ' ' && lapsePlayerAvailable()) {
      e.preventDefault();
      toggleLapsePlay();
      return;
    }
    if (e.key === 'ArrowRight' && lightbox) {
      navigateLightbox(1);
    }
    if (e.key === 'ArrowLeft' && lightbox) {
      navigateLightbox(-1);
    }
  }

  function formatDate(d) {
    return new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDateTime(d) {
    if (!d) return '';
    return new Date(d).toLocaleString('en-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  function getGalleryItemUrl(item) {
    if (typeof window === 'undefined' || !item?.id) return '';
    return new URL(`/gallery/${encodeURIComponent(item.id)}`, window.location.origin).toString();
  }

  function updateGalleryUrlForItem(item) {
    if (typeof window === 'undefined' || !item?.id) return;
    const nextPath = `/gallery/${encodeURIComponent(item.id)}`;
    if (window.location.pathname === nextPath) return;
    window.history.pushState({ galleryItemId: item.id }, '', nextPath);
  }

  function restoreGalleryUrl(path = '/gallery') {
    if (typeof window === 'undefined') return;
    window.history.replaceState({}, '', path);
  }

  async function copyGalleryLink(item) {
    const url = getGalleryItemUrl(item);
    if (!url) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      shareCopiedId = item.id;
      setTimeout(() => {
        if (shareCopiedId === item.id) shareCopiedId = null;
      }, 1800);
    } catch {
      window.prompt('Copy gallery link', url);
    }
  }

  async function openImageById(itemId) {
    try {
      const existing = items.find((item) => item.id === itemId);
      if (existing) {
        openLightbox(existing);
        return;
      }

      const res = await fetch(`${API_BASE}/api/gallery/${itemId}`, { headers: authHeaders() });
      if (!res.ok) return;
      const item = await res.json();
      syncLikedFromItems([item]);
      openLightbox(item);
    } catch {}
  }

  async function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const pathMatch = window.location.pathname.match(/^\/gallery\/([a-f0-9]{24})\/?$/);
    if (pathMatch) {
      await openImageById(pathMatch[1]);
      return;
    }

    const profilePathMatch = window.location.pathname.match(/^\/gallery\/([^/?#]+)\/?$/);
    if (profilePathMatch) {
      const profileSegment = decodeURIComponent(profilePathMatch[1]);
      if (profileSegment !== 'grid') {
        authorFilter = profileSegment;
      }
    }

    // Handle ?id= to open specific image
    const itemId = params.get('id');
    if (itemId) {
      await openImageById(itemId);
      return;
    }

    // Handle ?author= to filter by author
    const authorParam = params.get('author');
    if (authorParam) {
      authorFilter = authorParam;
    }

    const tagParam = params.get('tag');
    if (tagParam) {
      tagFilter = tagParam.trim().toLowerCase();
    }
  }

  onMount(() => {
    layout = initialLayoutFromEnv();
    checkAuth();
    loadDiscordConfig();
    window.addEventListener('message', handleDiscordMessage);
    checkUrlParams();
    fetchGallery();
    fetchSidebar();
    // Tag widths are measured with a canvas; re-measure once Inter is actually loaded.
    document.fonts?.ready.then(() => { tagFontVersion++; });
  });

  onDestroy(() => {
    window.removeEventListener('message', handleDiscordMessage);
    if (discordPopupPoll) clearInterval(discordPopupPoll);
  });
</script>

<svelte:window onkeydown={handleKeydown} onpopstate={handlePopState}/>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">

<div class="page">
  <nav>
    <a href="/" class="wordmark">DDraw!</a>
    <div class="nav-links">
      <span class="nav-active">gallery</span>
      <a href="/messenger/" class="nav-link">messenger</a>
      <a href="/go/" class="nav-enter" target="_blank">Draw Now! →</a>
      <span class="nav-divider">|</span>
      {#if user}
        <button class="btn-text" class:active={showFavorites} onclick={toggleFavoritesView}>favorites</button>
        <button class="btn-text" class:active={showLiked} onclick={toggleLikedView}>liked</button>
        <button class="nav-user" onclick={() => profileDialog.show(user.username)}>{user.username}</button>
        <button class="btn-text" onclick={logout}>logout</button>
      {:else}
        <button class="btn-text" onclick={() => openAuthModal('login')}>login</button>
      {/if}
    </div>
  </nav>

  <header>
    <div class="header-top">
      <div>
        {#if showLiked}
          <h1>My Likes</h1>
        {:else if showFavorites}
          <h1>My Favorites</h1>
        {:else if authorFilter}
          <h1>{authorFilter}'s Art</h1>
        {:else if tagFilter}
          <h1>{tagFilter}</h1>
        {:else}
          <h1 class="ggallery">GGallery</h1>
        {/if}
        <p>
          {#if showLiked}
            <button class="btn-link" onclick={toggleLikedView}>back to all</button>
          {:else if showFavorites}
            <button class="btn-link" onclick={toggleFavoritesView}>← back to all</button>
          {:else if tagFilter}
            <button class="btn-link" onclick={clearTagFilter}>Clear Tag</button>
          {:else if authorFilter}
            <button class="btn-link" onclick={clearAuthorFilter}>← back to all</button>
          {:else}
            Artwork made by the community
          {/if}
        </p>
      </div>
      {#if !showFavorites && !showLiked}
        <div class="view-toggle" aria-label="Gallery view" role="tablist">
          <button
            class="view-toggle-btn"
            class:active={layout === 'board'}
            onclick={() => setLayout('board')}
            aria-label="Board view"
            aria-pressed={layout === 'board'}
            title="Board view"
          >
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
              <rect x="1" y="1" width="16" height="3" rx="1"/>
              <rect x="1" y="7.5" width="16" height="3" rx="1"/>
              <rect x="1" y="14" width="16" height="3" rx="1"/>
            </svg>
          </button>
          <button
            class="view-toggle-btn"
            class:active={layout === 'grid'}
            onclick={() => setLayout('grid')}
            aria-label="Grid view"
            aria-pressed={layout === 'grid'}
            title="Grid view"
          >
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
              <rect x="1" y="1" width="6.5" height="6.5" rx="1"/>
              <rect x="10.5" y="1" width="6.5" height="6.5" rx="1"/>
              <rect x="1" y="10.5" width="6.5" height="6.5" rx="1"/>
              <rect x="10.5" y="10.5" width="6.5" height="6.5" rx="1"/>
            </svg>
          </button>
        </div>
        <div class="sort-controls">
          <button class="sort-btn" class:active={sort === 'newest'} onclick={() => setSort('newest')}>Newest</button>
          <button class="sort-btn" class:active={sort === 'active'} onclick={() => setSort('active')}>Active</button>
          <button class="sort-btn" class:active={sort === 'top'} onclick={() => setSort('top')}>Top</button>
          <button class="sort-btn" class:active={sort === 'views'} onclick={() => setSort('views')}>Views</button>
        </div>
        {#if sort === 'top'}
          <div class="top-period-controls" aria-label="Top time range">
            <button class="period-btn" class:active={topPeriod === 'week'} onclick={() => setTopPeriod('week')}>Week</button>
            <button class="period-btn" class:active={topPeriod === 'month'} onclick={() => setTopPeriod('month')}>Month</button>
            <button class="period-btn" class:active={topPeriod === 'year'} onclick={() => setTopPeriod('year')}>Year</button>
            <button class="period-btn" class:active={topPeriod === 'all'} onclick={() => setTopPeriod('all')}>All time</button>
          </div>
        {/if}
      {/if}
    </div>
  </header>

  <main>
    {#if loading}
      <div class="state-center">
        <div class="spinner"></div>
      </div>
    {:else if error}
      <div class="state-center">
        <p class="error-msg">{error}</p>
        <button class="btn-ghost" onclick={fetchCurrentPage}>Retry</button>
      </div>
    {:else if items.length === 0}
      <div class="state-center empty">
        <div class="empty-icon">◻</div>
        <h2>Nothing here yet</h2>
        <p>Be the first to save something to the gallery.</p>
        <a href="/go/" class="btn-primary" target="_blank">Start Drawing</a>
      </div>
    {:else}
      <div class="gallery-layout">
        <section class="gallery-main">
            <section class="tag-strip" aria-label="Image tags">
              <div class="tag-strip-head">
                <h2>Image Tags</h2>
                {#if tagFilter}
                  <button class="btn-link small-link" onclick={clearTagFilter}>clear</button>
                {/if}
              </div>
              {#if sidebarTags.length === 0}
                <p class="tag-strip-empty">{sidebarLoading ? 'Loading tags...' : 'No tags yet'}</p>
              {:else}
                <div class="tag-strip-list" bind:clientWidth={tagStripWidth}>
                  {#each visibleTags as entry}
                    <button class="tag-chip" class:active={tagFilter === entry.tag} onclick={() => filterByTag(entry.tag)}>
                      {entry.tag} <span>{entry.count}</span>
                    </button>
                  {/each}
                  {#if stripTags.length > tagPreviewCount}
                    <button class="tag-chip tag-expand" onclick={() => tagsExpanded = !tagsExpanded}>
                      {tagsExpanded ? "Show less" : `+${stripTags.length - tagPreviewCount} more`}
                    </button>
                  {/if}
                </div>
              {/if}
            </section>
          {#if layout === 'grid'}
          <div class="grid" bind:this={gridEl}>
        {#each items as item (item.id)}
          <div class="card" role="button" tabindex="0" onclick={() => openLightbox(item)} onkeydown={(e) => e.key === 'Enter' && openLightbox(item)}>
            <div class="card-img">
              <img src={item.thumbUrl || item.url} alt={item.title || 'artwork'} loading="lazy" class:censored={isNsfw(item) && !isNsfwRevealed(item)}>
              {#if item.animatedUrl && canPlayTimelapse(item)}
                <video
                  class="card-timelapse"
                  src={item.animatedUrl}
                  muted
                  loop
                  autoplay
                  playsinline
                ></video>
                <span class="card-timelapse-badge" title="Time-lapse">TIMELAPSE</span>
              {/if}
              {#if isNsfw(item)}
                <span class="card-badge">NSFW</span>
                {#if !isNsfwRevealed(item)}
                  <button class="censor-overlay" onclick={(e) => { e.stopPropagation(); revealNsfw(item); }} aria-label="Reveal censored image">
                    <strong>Reveal</strong>
                  </button>
                {/if}
              {/if}
            </div>
            <div class="card-meta">
              <div class="card-meta-main">
                {#if isAnonymousAuthor(item)}
                  <span class="card-author is-anon">{item.author}</span>
                {:else}
                  <button class="card-author" onclick={(e) => { e.stopPropagation(); profileDialog.show(item.author); }}>{item.author}</button>
                {/if}
                {#if item.createdAt}
                  <span class="card-date" title={formatDateTime(item.createdAt)}>{shortDate(item.createdAt)}</span>
                {/if}
              </div>
              <button
                class="like-btn"
                class:liked={likedIds.has(item.id)}
                onclick={(e) => { e.stopPropagation(); like(item); }}
                aria-label={`${item.likesCount || 0} likes`}
              >
                <svg class="like-icon" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1.24264 8.24264L8 15L14.7574 8.24264C15.553 7.44699 16 6.36786 16 5.24264V5.05234C16 2.8143 14.1857 1 11.9477 1C10.7166 1 9.55233 1.55959 8.78331 2.52086L8 3.5L7.21669 2.52086C6.44767 1.55959 5.28338 1 4.05234 1C1.8143 1 0 2.8143 0 5.05234V5.24264C0 6.36786 0.44699 7.44699 1.24264 8.24264Z"/>
                </svg>
                {item.likesCount || 0}
              </button>
            </div>
            {#if item.tags?.length}
              {@const fit = fitTags(item.tags, cardWidth, tagFontVersion)}
              <div class="card-tags-row">
                {#each fit.shown as tag}
                  <button class="tag-chip card-tag-chip" title={tag} onclick={(e) => { e.stopPropagation(); filterByTag(tag); }}>{tag}</button>
                {/each}
                {#if fit.hidden > 0}
                  <span class="tag-more" title={item.tags.slice(fit.shown.length).join(", ")}>+{fit.hidden}</span>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
          {:else}
          <div class="feed">
            {#each items as item (item.id)}
              <article class="post">
                <div class="post-head">
                  <button class="post-thumb" onclick={() => openLightbox(item)} aria-label={`Open ${item.title || 'image'}`}>
                    <img src={item.thumbUrl || item.url} alt={item.title || 'artwork'} loading="lazy" class:censored={isNsfw(item) && !isNsfwRevealed(item)} />
                    {#if item.animatedUrl && canPlayTimelapse(item)}
                      <video
                        class="card-timelapse"
                        src={item.animatedUrl}
                        muted
                        loop
                        autoplay
                        playsinline
                      ></video>
                      <span class="card-timelapse-badge" title="Time-lapse">TIMELAPSE</span>
                    {/if}
                    {#if isNsfw(item) && !isNsfwRevealed(item)}
                      <span class="reveal" onclick={(e) => { e.stopPropagation(); revealNsfw(item); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); revealNsfw(item); } }} role="button" tabindex="0">
                        <span>NSFW</span><strong>Reveal</strong>
                      </span>
                    {/if}
                  </button>

                  <div class="post-body">
                    <div class="post-meta">
                      {#if isAnonymousAuthor(item)}
                        <span class="post-author is-anon">{item.author}</span>
                      {:else}
                        <button class="post-author" onclick={() => profileDialog.show(item.author)}>{item.author}</button>
                      {/if}
                      <span class="post-dot">·</span>
                      <span class="post-date">{shortDate(item.createdAt)}</span>
                      {#if item.tags?.length}
                        <span class="post-dot">·</span>
                        <span class="post-tags">
                          {#each item.tags.slice(0, 4) as tag}
                            <button class="post-tag" onclick={() => filterByTag(tag)}>{tag}</button>
                          {/each}
                        </span>
                      {/if}
                    </div>
                    {#if item.title}
                      <h2 class="post-title">{item.title}</h2>
                    {/if}
                    {#if item.description}
                      <p class="post-description">{item.description}</p>
                    {/if}
                    <div class="post-actions">
                      <button class="like board-like" class:liked={likedIds.has(item.id)} onclick={() => like(item)}>
                        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1.24 8.24L8 15l6.76-6.76A4.76 4.76 0 0016 5.24v-.19A4.05 4.05 0 0011.95 1c-1.23 0-2.4.56-3.17 1.52L8 3.5l-.78-.98A4.05 4.05 0 004.05 1 4.05 4.05 0 000 5.05v.19c0 1.13.45 2.21 1.24 3z"/></svg>
                        {item.likesCount || 0}
                      </button>
                      <button class="comments-count" onclick={() => openLightbox(item)}>
                        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M14 1H2a1 1 0 00-1 1v9a1 1 0 001 1h2v3l3-3h7a1 1 0 001-1V2a1 1 0 00-1-1z"/></svg>
                        {boardCommentCountFor(item)}
                      </button>
                      <button class="open-thread" onclick={() => openLightbox(item)}>Open thread →</button>
                    </div>
                  </div>
                </div>

                <div class="thread-panel">
                  {#if boardCommentsById[item.id]?.length}
                    <ul class="thread">
                      {#each boardCommentsById[item.id] as c (c.id)}
                        <li class="reply">
                          <span class="reply-arrow">↳</span>
                          <button class="reply-author" onclick={() => profileDialog.show(c.author)}>{c.author}:</button>
                          <span class="reply-text">{c.text}</span>
                          <span class="reply-date">{shortDate(c.createdAt)}</span>
                        </li>
                      {/each}
                    </ul>
                    {#if !boardExpandedThreadIds.has(item.id) && boardCommentCountFor(item) > boardCommentsById[item.id].length}
                      <button class="more-comments" onclick={() => expandBoardThread(item)} disabled={boardThreadLoadingIds.has(item.id)}>
                        {boardThreadLoadingIds.has(item.id) ? 'Loading...' : `↓ Show all ${boardCommentCountFor(item)} comments`}
                      </button>
                    {:else if boardExpandedThreadIds.has(item.id) && boardCommentsById[item.id].length > BOARD_COMMENT_PREVIEW}
                      <button class="more-comments" onclick={() => collapseBoardThread(item)}>↑ Collapse thread</button>
                    {/if}
                  {:else if boardCommentCountFor(item) === 0}
                    <p class="thread-empty">No comments yet</p>
                  {/if}

                  {#if user}
                    <form class="board-comment-form" onsubmit={(e) => { e.preventDefault(); submitBoardComment(item); }}>
                      <input
                        type="text"
                        bind:value={boardCommentDraftsById[item.id]}
                        placeholder="Add a comment..."
                        maxlength="500"
                        disabled={boardCommentSubmittingById[item.id]}
                      />
                      <button type="submit" disabled={!boardCommentDraftsById[item.id]?.trim() || boardCommentSubmittingById[item.id]}>
                        {boardCommentSubmittingById[item.id] ? '...' : 'Post'}
                      </button>
                    </form>
                    {#if boardCommentErrorsById[item.id]}
                      <p class="board-comment-error">{boardCommentErrorsById[item.id]}</p>
                    {/if}
                  {:else}
                    <p class="login-to-comment">
                      <button class="btn-link" onclick={() => openAuthModal('login')}>Log in</button> to leave a comment
                    </p>
                  {/if}
                </div>
              </article>
            {/each}
          </div>
          {/if}

      {#if totalPages > 1}
        <div class="pagination">
          <button class="btn-ghost small pg-arrow" disabled={page <= 1} onclick={() => goToPage(page - 1)} aria-label="Previous page">←</button>
          {#each pageList as entry}
            {#if entry === '…'}
              <span class="pg-ellipsis">…</span>
            {:else}
              <button
                class="pg-num"
                class:active={entry === page}
                disabled={entry === page}
                onclick={() => goToPage(entry)}
                aria-label={`Page ${entry}`}
              >{entry}</button>
            {/if}
          {/each}
          <button class="btn-ghost small pg-arrow" disabled={page >= totalPages} onclick={() => goToPage(page + 1)} aria-label="Next page">→</button>
        </div>
      {/if}
        </section>

        <aside class="gallery-sidebar">
          <div class="sidebar-card">
            <div class="sidebar-head">
              <h2>Recent Comments</h2>
            </div>
            {#if recentCommentsFeed.length === 0}
              <p class="sidebar-empty">{sidebarLoading ? 'Loading comments...' : 'No recent comments'}</p>
            {:else}
              <div class="recent-comments">
                {#each recentCommentsFeed as entry (entry.id)}
                  <button class="recent-comment" onclick={() => openImageById(entry.image.id)}>
                    <img src={entry.image.thumbUrl} alt={entry.image.title || 'artwork'} class:censored={isNsfw(entry.image) && !isNsfwRevealed(entry.image)}>
                    <div class="recent-comment-body">
                      <div class="recent-comment-meta">
                        <span class="recent-comment-author">{entry.author}</span>
                        <span class="recent-comment-date">{shortDate(entry.createdAt)}</span>
                      </div>
                      <p>{entry.text}</p>
                      <strong>{entry.image.title || `by ${entry.image.author}`}</strong>
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </aside>
      </div>
    {/if}
  </main>

  <footer>
    <span>DDraw</span>
    <a href="/">← back to home</a>
  </footer>
</div>

{#if lightbox}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox-backdrop" class:instant={lightboxInstant} role="presentation" onclick={closeLightbox} onkeydown={(e) => e.key === 'Escape' && closeLightbox()}>
    <div class="lightbox-stage" bind:this={lightboxStage} onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      {#if canGoPrev()}
        <button class="lb-nav prev" onclick={() => navigateLightbox(-1)} aria-label="Previous image">&lsaquo;</button>
      {/if}
      <div class="lightbox" role="dialog" aria-modal="true" tabindex="-1">
        <button class="lb-control lb-fullscreen" onclick={toggleFullscreen} aria-label="Toggle fullscreen" title="Fullscreen">&#9974;</button>
        <button class="lb-close" onclick={closeLightbox}>&times;</button>
        <div class="lb-img-wrap" bind:this={lightboxImageWrap}>
          <img src={lightbox.url} alt={lightbox.title || 'artwork'} class:censored={isNsfw(lightbox) && !isNsfwRevealed(lightbox)}>
          {#if hasViewableTimelapse(lightbox) && !lapseFailed}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              class="lb-timelapse"
              class:hidden={!lapseMode}
              bind:this={lapseVideo}
              src={lightbox.animatedUrl}
              muted
              loop
              playsinline
              preload="auto"
              autoplay={!prefersReducedMotion}
              onloadedmetadata={onLapseMeta}
              ondurationchange={onLapseMeta}
              ontimeupdate={onLapseTime}
              onplay={() => lapsePlaying = true}
              onpause={() => lapsePlaying = false}
              onerror={() => lapseFailed = true}
              onclick={toggleLapsePlay}
            ></video>
          {/if}
          {#if isNsfw(lightbox) && !isNsfwRevealed(lightbox)}
            <button class="censor-overlay lightbox-censor" onclick={() => revealNsfw(lightbox)} aria-label="Reveal censored image">
              <span>NSFW content hidden</span>
              <strong>Reveal image</strong>
            </button>
          {/if}
          {#if hasViewableTimelapse(lightbox) && !lapseFailed}
            <div class="lb-lapse-bar" role="group" aria-label="Time-lapse playback">
              <button
                class="lb-lapse-btn"
                onclick={toggleLapsePlay}
                disabled={!lapsePlayerAvailable()}
                title={lapsePlaying ? 'Pause' : 'Play'}
                aria-label={lapsePlaying ? 'Pause time-lapse' : 'Play time-lapse'}
              >{lapsePlaying ? '❚❚' : '▶'}</button>
              <input
                class="lb-lapse-scrub"
                type="range"
                min="0"
                max={lapseDuration || 0}
                step="0.01"
                value={lapseTime}
                disabled={!lapsePlayerAvailable() || !lapseDuration}
                oninput={seekLapse}
                onpointerdown={() => lapseScrubbing = true}
                onpointerup={() => lapseScrubbing = false}
                onpointercancel={() => lapseScrubbing = false}
                aria-label="Scrub time-lapse"
              />
              <span class="lb-lapse-time">{formatClock(lapseTime)} / {formatClock(lapseDuration)}</span>
              <button
                class="lb-lapse-btn lb-lapse-mode"
                onclick={toggleLapseMode}
                title={lapseMode ? 'Show the finished image' : 'Show the time-lapse'}
              >{lapseMode ? 'Final' : 'Lapse'}</button>
            </div>
          {/if}
        </div>
        <div class="lb-info">
          <div class="lb-meta-block">
            <div class="lb-meta">
              {#if isAnonymousAuthor(lightbox)}
                <span class="lb-author is-anon">by {lightbox.author}</span>
              {:else}
                <button class="lb-author" onclick={() => profileDialog.show(lightbox.author)}>by {lightbox.author}</button>
              {/if}
              <span class="lb-date" title={formatDateTime(lightbox.createdAt)}>{formatDateTime(lightbox.createdAt)}</span>
            </div>
            <div class="lb-tags-row">
              <div class="lb-tags">
                {#if lightbox.tags?.length}
                  {#each lightbox.tags as tag}
                    <button class="tag-chip" onclick={() => { closeLightbox(); filterByTag(tag); }}>{tag}</button>
                  {/each}
                {:else if canEditTags(lightbox)}
                  <button class="tag-editor-toggle tag-editor-toggle-inline" onclick={() => tagEditorOpen = true} aria-label="Add tags">
                    +Tag
                  </button>
                {:else}
                  <span class="lb-tags-empty">No tags yet</span>
                {/if}
              </div>
            </div>
          </div>

          {#if lightbox.title}
            <p class="lb-caption">{lightbox.title}</p>
          {/if}
          {#if lightbox.description}
            <p class="lb-description">{lightbox.description}</p>
          {/if}

          <div class="lb-actions">
            <button
              class="like-btn large"
              class:liked={likedIds.has(lightbox.id)}
              onclick={() => like(lightbox)}
            >
              <svg class="like-icon" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M1.24264 8.24264L8 15L14.7574 8.24264C15.553 7.44699 16 6.36786 16 5.24264V5.05234C16 2.8143 14.1857 1 11.9477 1C10.7166 1 9.55233 1.55959 8.78331 2.52086L8 3.5L7.21669 2.52086C6.44767 1.55959 5.28338 1 4.05234 1C1.8143 1 0 2.8143 0 5.05234V5.24264C0 6.36786 0.44699 7.44699 1.24264 8.24264Z"/>
              </svg>
              {lightbox.likesCount || 0}
            </button>
            {#if user}
              <button
                class="fav-btn"
                class:favorited={favoritedIds.has(lightbox.id)}
                onclick={() => toggleFavorite(lightbox)}
                title={favoritedIds.has(lightbox.id) ? 'Remove from favorites' : 'Add to favorites'}
              >
                <svg class="fav-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                </svg>
              </button>
            {/if}
            <button class="btn-ghost small" onclick={() => copyGalleryLink(lightbox)}>
              {shareCopiedId === lightbox.id ? 'Copied' : 'Share'}
            </button>
            <button class="btn-ghost small" onclick={() => downloadImage(lightbox.url, `${lightbox.title || lightbox.id}.png`)}>Download</button>
            {#if canEditTimelapse(lightbox)}
              <button class="btn-ghost small" onclick={() => timelapseEditorOpen = true} title="Re-crop or trim the timelapse">Edit timelapse</button>
              <button class="btn-ghost small" onclick={() => removeTimelapse(lightbox)} title="Remove the timelapse">Remove timelapse</button>
            {/if}
            {#if canDeleteImage(lightbox)}
              <button class="btn-danger small" onclick={() => deleteImage(lightbox)}>Delete</button>
            {/if}
          </div>

          {#if canEditTags(lightbox) && lightbox.tags?.length}
            <div class="lb-tag-actions">
              <button class="tag-editor-toggle tag-editor-toggle-inline" onclick={() => tagEditorOpen = !tagEditorOpen} aria-label={tagEditorOpen ? 'Hide tag editor' : 'Edit tags'}>
                +Tag
              </button>
            </div>
          {/if}

          {#if canEditTags(lightbox) && tagEditorOpen}
            <div class="tag-editor">
              <label for="tagEditorInput">Tags</label>
              <div class="tag-editor-row">
                <input id="tagEditorInput" type="text" bind:value={tagDraft} placeholder="nsfw, portrait, pixel-art" />
                <button class="btn-ghost small" onclick={saveTags} disabled={tagSaving}>
                  {tagSaving ? 'Saving...' : 'Save Tags'}
                </button>
              </div>
              <p class="tag-editor-hint">Comma-separated tags. Use <code>nsfw</code> for adult or sensitive images.</p>
            </div>
          {/if}

          <!-- Comments Section -->
          <div class="comments-section">
            {#if commentsLoading}
              <p class="comments-loading">Loading...</p>
            {:else if comments.length === 0}
              <p class="comments-empty">No comments yet</p>
            {:else}
              <div class="comments-list">
                {#each comments as comment (comment.id)}
                  <div class="comment">
                    <div class="comment-header">
                      <button class="comment-author" onclick={() => profileDialog.show(comment.author)}>{comment.author}</button>
                      <span class="comment-date">{formatDate(comment.createdAt)}</span>
                      {#if comment.edited}
                        <span class="comment-edited">Edited</span>
                      {/if}
                      {#if canEditComment(comment)}
                        <button class="comment-action" onclick={() => beginCommentEdit(comment)} disabled={commentActionBusy && editingCommentId !== comment.id}>
                          Edit
                        </button>
                      {/if}
                      {#if canDeleteComment(comment)}
                        <button class="comment-delete" onclick={() => deleteComment(comment.id)} title="Delete" disabled={commentActionBusy}>&times;</button>
                      {/if}
                    </div>
                    {#if editingCommentId === comment.id}
                      <form class="comment-edit-form" onsubmit={(e) => { e.preventDefault(); saveCommentEdit(comment.id); }}>
                        <input type="text" bind:value={editingCommentText} maxlength="500" disabled={commentActionBusy} />
                        <div class="comment-edit-actions">
                          <button type="submit" class="btn-primary small" disabled={!editingCommentText.trim() || commentActionBusy}>Save</button>
                          <button type="button" class="btn-ghost small" onclick={cancelCommentEdit} disabled={commentActionBusy}>Cancel</button>
                        </div>
                      </form>
                    {:else}
                      <p class="comment-text">{comment.text}</p>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            {#if user}
              <form class="comment-form" onsubmit={(e) => { e.preventDefault(); submitComment(); }}>
                <input
                  type="text"
                  bind:value={newComment}
                  placeholder="Add a comment..."
                  maxlength="500"
                  disabled={commentSubmitting}
                />
                <button type="submit" class="btn-primary small" disabled={!newComment.trim() || commentSubmitting}>
                  {commentSubmitting ? '...' : 'Post'}
                </button>
              </form>
            {:else}
              <p class="comments-login-hint">
                <button class="btn-link" onclick={() => openAuthModal('login')}>Log in</button> to comment
              </p>
            {/if}
          </div>
        </div>
      </div>
      {#if canGoNext()}
        <button class="lb-nav next" onclick={() => navigateLightbox(1)} aria-label="Next image">&rsaquo;</button>
      {/if}
    </div>
  </div>
{/if}

{#if timelapseEditorOpen && lightbox}
  <TimelapseEditor
    item={lightbox}
    apiBase={API_BASE}
    token={readToken()}
    onSaved={(animatedUrl) => applyTimelapseChange(animatedUrl)}
    onRemoved={() => applyTimelapseChange(null)}
    onClose={() => timelapseEditorOpen = false}
  />
{/if}

{#if showAuthModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" role="presentation" onclick={closeAuthModal} onkeydown={(e) => e.key === 'Escape' && closeAuthModal()}>
    <div class="modal" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      <button class="modal-close" onclick={closeAuthModal}>×</button>
      <h2>{authMode === 'login' ? 'Login' : 'Register'}</h2>

      {#if discordEnabled}
        <button type="button" class="btn-discord" onclick={startDiscordOAuth} disabled={authLoading}>
          <svg width="18" height="18" viewBox="0 0 127.14 96.36" aria-hidden="true"><path fill="currentColor" d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
          Login with Discord
        </button>
        <div class="auth-divider"><span>or</span></div>
      {/if}

      <form onsubmit={(e) => { e.preventDefault(); authMode === 'login' ? handleLogin() : handleRegister(); }}>
        <label>
          <span>Username</span>
          <input type="text" bind:value={authForm.username} autocomplete="username" />
        </label>
        <label>
          <span>Password</span>
          <input type="password" bind:value={authForm.password} autocomplete={authMode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        {#if authMode === 'register'}
          <label>
            <span>Email (optional)</span>
            <input type="email" bind:value={authForm.email} autocomplete="email" />
          </label>
        {/if}

        <label class="auth-remember">
          <input type="checkbox" bind:checked={rememberMe} />
          <span>Stay logged in (30 days)</span>
        </label>

        {#if authError}
          <p class="auth-error">{authError}</p>
        {/if}

        <button type="submit" class="btn-primary" disabled={authLoading}>
          {authLoading ? '...' : (authMode === 'login' ? 'Login' : 'Register')}
        </button>
      </form>

      <p class="auth-switch">
        {#if authMode === 'login'}
          Don't have an account? <button class="btn-link" onclick={() => authMode = 'register'}>Register</button>
        {:else}
          Already have an account? <button class="btn-link" onclick={() => authMode = 'login'}>Login</button>
        {/if}
      </p>
    </div>
  </div>
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) {
    background: #0f0f13;
    color: #e8e2d5;
    font-family: 'Inter', -apple-system, sans-serif;
    font-weight: 400;
    overflow-x: hidden;
  }
  :global(a) { color: inherit; text-decoration: none; }

  :global(body)::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      radial-gradient(circle, rgba(200,0,200,0.03) 1px, transparent 1px),
      radial-gradient(circle, rgba(0,212,170,0.03) 1px, transparent 1px);
    background-size: 40px 40px;
    background-position: 0 0, 20px 20px;
    pointer-events: none;
    z-index: 0;
  }

  :global(:root) {
    --bg: #0f0f13;
    --bg2: #1a1a1e;
    --text: #ffffff;
    --text-dim: rgba(255,255,255,0.45);
    --accent: #00d4aa;
    --magenta: #c800c8;
    --yellow: #ffdd00;
    --teal: #5b9e8f;
    --border: rgba(255,255,255,0.1);
  }

  .page { min-height: 100vh; display: flex; flex-direction: column; position: relative; z-index: 1; }

  /* ── Nav ── */
  nav {
    position: sticky;
    top: 0; z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2rem;
    height: 64px;
    backdrop-filter: blur(12px);
    background: rgba(15,15,19,0.85);
    border-bottom: 2px solid var(--accent);
  }

  .wordmark {
    font-family: 'Fredoka', sans-serif;
    font-weight: 700;
    font-size: 22px;
    color: var(--accent);
    transform: rotate(-2deg);
  }

  .nav-links {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    font-size: 0.85rem;
    letter-spacing: 0.05em;
    font-weight: 500;
  }
  .nav-links a {
    transition: all 0.2s;
  }
  .nav-links a:hover {
    color: var(--accent);
    transform: translateY(-1px);
  }
  .nav-active { color: var(--text-dim); }
  .nav-enter {
    background: var(--accent);
    color: #000 !important;
    padding: 0.5rem 1rem;
    border-radius: 50px;
    font-weight: 700;
  }
  .nav-enter:hover {
    color: #000 !important;
    transform: translateY(-1px) scale(1.03);
  }
  .nav-divider { color: var(--border); }
  .nav-user {
    color: var(--text);
    background: none;
    border: none;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
    transition: all 0.2s;
  }
  .nav-user:hover {
    color: var(--accent);
    transform: translateY(-1px);
  }

  .btn-text {
    background: none;
    border: none;
    color: var(--text-dim);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
  }
  .btn-text:hover { color: var(--text); }
  .btn-text.active { color: var(--accent); }

  /* ── Header ── */
  header {
    padding: 2rem 3rem 1.25rem;
    border-bottom: 2px solid var(--border);
  }
  .header-top {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 2rem;
    flex-wrap: wrap;
  }
  header h1 {
    font-family: 'Inter', sans-serif;
    font-weight: 500;
    font-size: clamp(1.5rem, 3vw, 2rem);
    letter-spacing: -0.02em;
    margin-bottom: 0.5rem;
    color: var(--text);
  }
  header h1.ggallery {
    font-family: 'Fredoka', sans-serif;
    font-weight: 700;
    font-size: clamp(2.2rem, 5vw, 3.4rem);
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--accent);
    transform: rotate(-2deg);
    display: inline-block;
  }
  header p { color: var(--text-dim); font-size: 0.9rem; }

  .view-toggle {
    display: inline-flex;
    align-items: center;
    padding: 3px;
    margin-bottom: 0.75rem;
    border: 1.5px solid var(--border);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.035);
  }
  .view-toggle .active {
    color: #000;
    background: var(--accent);
  }

  /* Segmented control, matches .view-toggle */
  .sort-controls, .top-period-controls {
    display: inline-flex;
    align-items: center;
    padding: 3px;
    margin-bottom: 0.5rem;
    border: 1.5px solid var(--border);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.035);
  }
  .sort-btn, .period-btn {
    background: none;
    border: none;
    color: var(--text-dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.4rem 0.9rem;
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.2s, background 0.2s;
  }
  .period-btn {
    font-size: 0.74rem;
    padding: 0.3rem 0.7rem;
  }
  .sort-btn:hover, .period-btn:hover {
    color: var(--accent);
  }
  .sort-btn.active, .period-btn.active {
    color: #000;
    background: var(--accent);
  }

  /* ── Main ── */
  main {
    flex: 1;
    padding: 3rem;
  }

  .gallery-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 240px;
    gap: 1.5rem;
    align-items: start;
  }

  .tag-strip {
    padding: 0.85rem 1rem;
    margin-bottom: 1.5rem;
    border: 1.5px solid var(--border);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.025);
  }
  .tag-strip-head {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    margin-bottom: 0.65rem;
  }
  .tag-strip h2 {
    color: var(--text);
    font-size: 0.88rem;
    font-weight: 600;
  }
  .tag-strip-empty {
    color: var(--text-dim);
    font-size: 0.82rem;
  }
  .tag-strip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
  }

  .gallery-main {
    min-width: 0;
  }

  .gallery-sidebar {
    position: sticky;
    top: 5.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .sidebar-card {
    background: rgba(255, 255, 255, 0.02);
    border: 1.5px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    transition: border-color 0.2s;
  }

  .sidebar-card:hover {
    border-color: rgba(255, 255, 255, 0.15);
  }

  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.8rem;
  }

  .sidebar-head h2 {
    font-size: 0.95rem;
    font-weight: 400;
  }

  .sidebar-empty {
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  .recent-comments {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .recent-comment {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 0.75rem;
    background: none;
    border: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: all 0.2s;
    padding: 0.5rem;
    margin: -0.5rem;
    border-radius: 6px;
  }

  .recent-comment:hover {
    background: rgba(0, 212, 170, 0.05);
  }

  .recent-comment img {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: 6px;
    border: 2px solid var(--border);
    transition: border-color 0.2s, filter 0.2s;
  }

  .recent-comment:hover img {
    border-color: var(--accent);
  }

  .recent-comment-meta {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--text-dim);
    margin-bottom: 0.25rem;
  }

  .recent-comment-author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-comment-date {
    white-space: nowrap;
    flex-shrink: 0;
  }

  .recent-comment-body p {
    font-size: 0.8rem;
    line-height: 1.35;
    margin-bottom: 0.3rem;
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .recent-comment-body strong {
    font-size: 0.76rem;
    color: var(--text-dim);
    font-weight: 400;
  }

  /* ── States ── */
  .state-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    min-height: 40vh;
    text-align: center;
  }

  .spinner {
    width: 36px; height: 36px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-msg { color: var(--text-dim); }

  .empty-icon {
    font-size: 3rem;
    color: var(--border);
    line-height: 1;
  }
  .empty h2 {
    font-family: 'Inter', sans-serif;
    font-size: 1.5rem;
    font-weight: 400;
  }
  .empty p { color: var(--text-dim); font-size: 0.9rem; }

  /* ── Grid ── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 1.25rem;
    align-items: start;
  }

  .card {
    background: none;
    border: 2px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    align-self: start;
    cursor: pointer;
    transition: border-color 0.25s, transform 0.25s, box-shadow 0.25s;
    text-align: left;
    padding: 0;
    color: var(--text);
  }
  .card:hover {
    border-color: var(--accent);
    transform: translateY(-4px);
    box-shadow: 0 8px 16px rgba(0, 212, 170, 0.15);
  }

  .card-img {
    position: relative;
    /* Measured over 72 gallery images: median aspect 1.01, mean 1.11. A square
       box wastes the least room under object-fit: contain (77% mean fill vs
       70% at 4:3), since portrait uploads are common. */
    aspect-ratio: 1 / 1;
    overflow: hidden;
    background: var(--bg2);
  }
  /* Inset frame so mostly-white artwork still reads as a canvas, not a glitch */
  .card-img::after {
    content: '';
    position: absolute;
    inset: 0;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12), inset 0 0 24px rgba(0, 0, 0, 0.05);
    pointer-events: none;
    z-index: 2;
  }
  .card-img img {
    width: 100%; height: 100%;
    object-fit: contain;
    display: block;
    transition: transform 0.4s ease, filter 0.2s ease;
  }
  .card:hover .card-img img { transform: scale(1.05); }

  .card-timelapse {
    position: absolute;
    inset: 0;
    width: 100%; height: 100%;
    object-fit: contain;
    display: block;
    background: var(--bg2);
    z-index: 1;
  }

  .card-timelapse-badge {
    position: absolute;
    top: 0.4rem;
    left: 0.4rem;
    z-index: 2;
    padding: 0.1rem 0.4rem;
    border-radius: 0.35rem;
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: #fff;
    background: rgba(0, 212, 170, 0.85);
    pointer-events: none;
    text-transform: uppercase;
  }

  .censored {
    filter: blur(20px) saturate(0.7);
  }

  .censor-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    background: rgba(8, 8, 12, 0.58);
    border: none;
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    z-index: 1;
  }
  .censor-overlay span {
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  /* The overlay is the button, but only this pill looks like one, so the
     hover/focus states are driven off the overlay rather than the pill. */
  .censor-overlay strong {
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.42rem 0.95rem;
    border-radius: 999px;
    border: 1.5px solid var(--accent);
    background: rgba(0, 0, 0, 0.55);
    color: var(--accent);
    transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease,
      box-shadow 0.15s ease;
  }
  .censor-overlay:hover strong,
  .censor-overlay:focus-visible strong {
    background: var(--accent);
    color: #000;
    transform: translateY(-1px);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  }
  .censor-overlay:active strong {
    transform: translateY(0);
    box-shadow: none;
  }
  .censor-overlay:focus-visible {
    outline: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .censor-overlay strong { transition: none; }
    .censor-overlay:hover strong,
    .censor-overlay:focus-visible strong { transform: none; }
  }

  .card-badge {
    position: absolute;
    top: 0.65rem;
    right: 0.65rem;
    background: rgba(0, 0, 0, 0.85);
    border: 1.5px solid var(--accent);
    border-radius: 999px;
    padding: 0.28rem 0.55rem;
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    color: var(--accent);
    font-weight: 600;
    backdrop-filter: blur(8px);
  }

  /* The footer is chrome — keep it tight so the artwork stays the focus. */
  .card-meta {
    padding: 0.4rem 0.55rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    background: var(--bg2);
    border-top: 1px solid var(--border);
  }
  .card-meta-main {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    overflow: hidden;
  }
  .card-author {
    font-size: 0.78rem;
    color: rgba(255, 255, 255, 0.7);
    background: none;
    border: none;
    font-family: inherit;
    cursor: pointer;
    padding: 3px 6px;
    margin: -3px -6px;
    /* 24px touch target kept; the row tightens via padding, not hit area. */
    min-height: 24px;
    min-width: 24px;
    display: inline-block;
    /* 3px padding + 18px line = the 24px min-height exactly, so text stays centred */
    line-height: 18px;
    text-align: left;
    flex: 0 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.15s;
  }
  .card-author:hover { color: var(--accent); }
  .card-author.is-anon,
  .post-author.is-anon,
  .lb-author.is-anon { cursor: default; font-style: italic; }
  .card-author.is-anon:hover { color: rgba(255, 255, 255, 0.7); }
  .post-author.is-anon:hover { text-decoration: none; }
  .lb-author.is-anon:hover { color: var(--text-dim); }

  .card-date {
    flex: 0 0 auto;
    font-size: 0.68rem;
    line-height: 1.15;
    color: var(--text-dim);
    white-space: nowrap;
  }

  /* No top border: reads as one footer block with .card-meta rather than two bars. */
  .card-tags-row {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.3rem;
    padding: 0 0.55rem 0.45rem;
    background: var(--bg2);
    align-items: center;
    /* Safety net only: chips shrink to fit, so this should never actually clip. */
    overflow: hidden;
  }

  .card-tags-row .card-tag-chip {
    padding: 0.12rem 0.45rem;
    font-size: 0.68rem;
    border-width: 1px;
    display: inline-block;
    line-height: 1.3;
    /* fitTags() only emits chips that fit at natural width, so no shrinking.
       The ellipsis is the fallback for the one case fitTags can't solve: a
       single tag wider than the whole row. */
    flex: 0 1 auto;
    min-width: 0;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-tags-row .card-tag-chip:hover { transform: none; }

  .card-tags-row .tag-more {
    flex: 0 0 auto;
    white-space: nowrap;
    font-size: 0.68rem;
  }

  .tag-more {
    font-size: 0.75rem;
    color: var(--text-dim);
    font-weight: 500;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1.5px solid var(--border);
    border-radius: 999px;
    color: rgba(255, 255, 255, 0.7);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.32rem 0.65rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .tag-chip:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: rgba(0, 212, 170, 0.1);
    transform: translateY(-1px);
  }

  /* Not a tag — the row-expander. Dimmer and dashed so it reads as a control,
     and it stays neutral on hover instead of taking the tag accent. */
  .tag-expand {
    border-style: dashed;
    border-color: rgba(255, 255, 255, 0.12);
    background: transparent;
    color: var(--text-dim);
    opacity: 0.7;
  }

  .tag-expand:hover {
    opacity: 1;
    color: var(--text);
    border-color: rgba(255, 255, 255, 0.28);
    background: rgba(255, 255, 255, 0.04);
    transform: none;
  }


  /* ── Like Button ── */
  .like-btn {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 0.85rem;
    cursor: pointer;
    font-family: 'Inter', -apple-system, sans-serif;
    padding: 6px 10px;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .like-icon {
    width: 1.2em;
    height: 1.2em;
    flex-shrink: 0;
  }
  .card-meta .like-btn {
    font-size: 0.78rem;
    padding: 3px 5px;
    margin: -3px -5px;
    min-height: 24px;
    gap: 0.35rem;
  }
  .like-btn:hover { color: #e07070; }
  .like-btn.liked { color: #e07070; }
  .like-btn.large {
    font-size: 1rem;
    padding: 8px 14px;
    border: 1.5px solid var(--border);
    gap: 0.75rem;
  }
  .like-btn.large .like-icon {
    width: 1.4em;
    height: 1.4em;
  }
  .like-btn.large:hover, .like-btn.large.liked {
    border-color: #e07070;
    background: rgba(224, 112, 112, 0.08);
  }

  /* ── Favorite Button ── */
  .fav-btn {
    background: none;
    border: 1.5px solid var(--border);
    color: var(--text-dim);
    cursor: pointer;
    padding: 8px 14px;
    border-radius: 4px;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .fav-icon {
    width: 1.4em;
    height: 1.4em;
  }
  .fav-btn:hover {
    color: #f0c040;
    border-color: #f0c040;
    background: rgba(240, 192, 64, 0.08);
  }
  .fav-btn.favorited {
    color: #f0c040;
    border-color: #f0c040;
    background: rgba(240, 192, 64, 0.08);
  }

  /* ── Pagination ── */
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 3rem;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .pg-num {
    min-width: 2rem;
    padding: 0.4rem 0.7rem;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text-dim);
    font: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .pg-num:hover:not(:disabled):not(.active) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .pg-num.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #0f0f13;
    font-weight: 600;
    cursor: default;
  }
  .pg-ellipsis {
    padding: 0 0.3rem;
    color: var(--text-dim);
    user-select: none;
  }
  .pg-arrow {
    min-width: 2rem;
    padding: 0.4rem 0.7rem;
  }

  /* ── Buttons ── */
  .btn-primary {
    display: inline-block;
    padding: 0.7rem 1.75rem;
    background: var(--accent);
    color: #0f0f13;
    font-family: 'Inter', -apple-system, sans-serif;
    font-weight: 600;
    font-size: 0.88rem;
    letter-spacing: 0.04em;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
    text-decoration: none;
  }
  .btn-primary:hover {
    background: #00f0c3;
    transform: translateY(-2px);
  }
  .btn-primary:disabled { opacity: 0.5; cursor: default; }

  .btn-ghost {
    display: inline-block;
    padding: 0.6rem 1.25rem;
    border: 2px solid var(--border);
    color: var(--text-dim);
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 0.85rem;
    border-radius: 6px;
    background: none;
    cursor: pointer;
    transition: all 0.2s;
    text-decoration: none;
  }
  .btn-ghost:hover {
    border-color: var(--accent);
    color: var(--accent);
    transform: translateY(-1px);
  }
  .btn-ghost:disabled { opacity: 0.3; cursor: default; }
  .btn-ghost.small { padding: 0.45rem 0.9rem; font-size: 0.8rem; }

  .btn-danger {
    background: transparent;
    border: 1px solid #c53030;
    color: #fc8181;
    padding: 0.6rem 1.2rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }
  .btn-danger:hover { background: #c53030; color: #fff; }
  .btn-danger.small { padding: 0.45rem 0.9rem; font-size: 0.8rem; }

  .btn-link {
    background: none;
    border: none;
    color: var(--accent);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }

  /* ── Footer ── */
  footer {
    padding: 1.5rem 3rem;
    border-top: 2px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  footer a {
    transition: color 0.2s;
  }
  footer a:hover { color: var(--accent); }

  /* ── Lightbox ── */
  .lightbox-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    backdrop-filter: blur(4px);
    animation: fadeIn 0.15s ease;
  }
  .lightbox-backdrop.instant {
    animation: none;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .lightbox {
    background: var(--bg2);
    border: 2px solid var(--accent);
    border-radius: 12px;
    overflow: hidden;
    width: min(920px, 100%);
    height: min(82vh, 820px);
    min-height: 640px;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    position: relative;
    animation: slideUp 0.2s ease;
    box-shadow: 0 20px 60px rgba(0, 212, 170, 0.2);
  }
  .lightbox-backdrop.instant .lightbox {
    animation: none;
  }
  @keyframes slideUp { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  .lightbox-stage {
    width: min(1120px, 100%);
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 1.25rem;
  }

  .lb-control,
  .lb-close {
    position: absolute;
    top: 0.75rem;
    background: rgba(0,0,0,0.5);
    border: none;
    color: var(--text);
    font-size: 1.2rem;
    line-height: 1;
    width: 28px; height: 28px;
    border-radius: 50%;
    cursor: pointer;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .lb-close { right: 0.75rem; }
  .lb-fullscreen {
    right: 3rem;
    font-size: 0.95rem;
  }

  .lb-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 56px;
    height: 56px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(0,0,0,0.7);
    color: var(--text);
    font-size: 2.35rem;
    line-height: 1;
    cursor: pointer;
    z-index: 2;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(8px);
    transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
  }
  .lb-nav:hover {
    transform: translateY(-50%) scale(1.04);
    border-color: var(--accent);
    background: rgba(0,0,0,0.82);
  }
  .lb-nav.prev { left: -1.75rem; }
  .lb-nav.next { right: -1.75rem; }
  .lightbox-stage > .lb-nav.prev {
    position: static;
    transform: none;
    grid-column: 1;
  }
  .lightbox-stage > .lb-nav.next {
    position: static;
    transform: none;
    grid-column: 3;
  }
  .lightbox-stage > .lb-nav:hover {
    transform: scale(1.04);
  }
  .lightbox {
    grid-column: 2;
  }

  .lb-img-wrap {
    position: relative;
    /* Contain the time-lapse layer's z-index so it can't paint over the
       close/fullscreen buttons, which are siblings of this wrap. */
    isolation: isolate;
    overflow: hidden;
    background: #2a2a2a;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }
  .lb-img-wrap img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }

  /* Time-lapse sits over the still, letterboxed against the same backdrop so a
     clip cropped tighter than the upload doesn't reveal a misaligned image. */
  .lb-timelapse.hidden { display: none; }
  .lb-timelapse {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    background: #2a2a2a;
    cursor: pointer;
    z-index: 1;
  }

  .lb-lapse-bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.9rem 0.75rem 0.55rem;
    background: linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0));
  }

  .lb-lapse-btn {
    flex: none;
    min-width: 30px;
    height: 26px;
    padding: 0 0.5rem;
    border: 1px solid rgba(255,255,255,0.25);
    border-radius: 6px;
    background: rgba(0,0,0,0.55);
    color: #fff;
    font-family: inherit;
    font-size: 0.72rem;
    line-height: 1;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .lb-lapse-btn:hover:not(:disabled) {
    border-color: var(--accent);
    background: rgba(0,0,0,0.75);
  }
  .lb-lapse-btn:disabled { opacity: 0.45; cursor: default; }

  .lb-lapse-time {
    flex: none;
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    color: rgba(255,255,255,0.8);
  }

  .lb-lapse-scrub {
    flex: 1 1 auto;
    min-width: 0;
    height: 20px;
    margin: 0;
    background: none;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
  }
  .lb-lapse-scrub:disabled { opacity: 0.45; cursor: default; }
  .lb-lapse-scrub::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: rgba(255,255,255,0.3);
  }
  .lb-lapse-scrub::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: rgba(255,255,255,0.3);
  }
  .lb-lapse-scrub::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border: none;
    border-radius: 50%;
    background: var(--accent);
  }
  .lb-lapse-scrub::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border: none;
    border-radius: 50%;
    background: var(--accent);
  }
  .lb-lapse-scrub:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .lightbox-censor {
    font-size: 0.9rem;
  }

  .lb-info {
    padding: 1rem 1.25rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 220px;
  }

  .lb-meta-block {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .lb-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .lb-author {
    background: none;
    border: none;
    color: var(--text-dim);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
    transition: color 0.15s;
  }
  .lb-author:hover { color: var(--accent); }

  .lb-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .lb-tags-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .lb-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .lb-caption {
    font-size: 0.92rem;
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.82);
  }

  .lb-tags-empty {
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  .lb-tag-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .tag-editor-toggle {
    width: 2rem;
    height: 2rem;
    flex: 0 0 auto;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.04);
    color: var(--text);
    font-family: inherit;
    font-size: 1.15rem;
    line-height: 1;
    cursor: pointer;
    transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease, transform 0.2s ease;
  }
  .tag-editor-toggle:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(0, 212, 170, 0.1);
    transform: translateY(-1px);
  }

  .tag-editor-toggle-inline {
    width: auto;
    min-width: 0;
    padding: 0.42rem 0.8rem;
    font-size: 0.8rem;
    line-height: 1.1;
  }

  .tag-editor {
    padding-top: 0.25rem;
  }

  .tag-editor label {
    display: block;
    font-size: 0.82rem;
    color: var(--text-dim);
    margin-bottom: 0.45rem;
  }

  .tag-editor-row {
    display: flex;
    gap: 0.5rem;
  }

  .tag-editor-row input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
  }

  .tag-editor-row input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .tag-editor-hint {
    margin-top: 0.45rem;
    font-size: 0.75rem;
    color: var(--text-dim);
  }

  /* ── Comments ── */
  .comments-section {
    margin-top: 0.2rem;
    border-top: 1px solid var(--border);
  }
  .comments-loading, .comments-empty {
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .comments-list {
    max-height: 200px;
    overflow-y: auto;
    margin-bottom: 0.75rem;
    padding-right: 0.35rem;
    scrollbar-width: thin;
    scrollbar-color: rgba(0, 212, 170, 0.45) rgba(255, 255, 255, 0.05);
  }
  .comments-list::-webkit-scrollbar {
    width: 10px;
  }
  .comments-list::-webkit-scrollbar-track {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 999px;
  }
  .comments-list::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, rgba(0, 212, 170, 0.72), rgba(91, 158, 143, 0.72));
    border-radius: 999px;
    border: 2px solid rgba(15, 15, 19, 0.9);
  }
  .comments-list::-webkit-scrollbar-thumb:hover {
    background: linear-gradient(180deg, rgba(0, 240, 195, 0.92), rgba(91, 158, 143, 0.88));
  }
  .comment {
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border);
  }
  .comment:last-child { border-bottom: none; }
  .comment-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  .comment-author {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text);
    background: none;
    border: none;
    font-family: inherit;
    cursor: pointer;
    padding: 0;
    transition: color 0.15s;
  }
  .comment-author:hover { color: var(--accent); }
  .comment-date {
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  .comment-delete {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 0.9rem;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .comment-action {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0;
    font-family: inherit;
  }
  .comment-delete:hover { color: #e07070; }
  .comment-action:disabled, .comment-delete:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .comment-edited {
    font-size: 0.68rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .comment-text {
    font-size: 0.82rem;
    color: var(--text);
    line-height: 1.4;
    word-break: break-word;
  }
  .comment-form {
    display: flex;
    gap: 0.5rem;
  }
  .comment-edit-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .comment-edit-form input,
  .comment-form input {
    flex: 1;
    margin-top:0.5rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
  }
  .comment-edit-form input:focus,
  .comment-form input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .comment-edit-actions {
    display: flex;
    gap: 0.5rem;
  }
  .btn-primary.small {
    padding: 0.5rem 0.9rem;
    font-size: 0.78rem;
  }
  .comments-login-hint {
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  /* ── Auth Modal ── */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    backdrop-filter: blur(4px);
    animation: fadeIn 0.15s ease;
  }

  .modal {
    background: var(--bg2);
    border: 2px solid var(--accent);
    border-radius: 12px;
    padding: 2rem;
    max-width: 360px;
    width: 100%;
    position: relative;
    animation: slideUp 0.2s ease;
    box-shadow: 0 20px 60px rgba(0, 212, 170, 0.2);
  }

  .modal-close {
    position: absolute;
    top: 0.75rem; right: 0.75rem;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 1.2rem;
    cursor: pointer;
  }
  .modal-close:hover { color: var(--text); }

  .modal h2 {
    font-family: 'Inter', sans-serif;
    font-size: 1.25rem;
    font-weight: 400;
    margin-bottom: 1.5rem;
  }

  .modal form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .modal label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  .modal input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.6rem 0.75rem;
    color: var(--text);
    font-family: inherit;
    font-size: 0.9rem;
  }
  .modal input:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* Overrides the column-flex `.modal label` / padded `.modal input` defaults. */
  .modal label.auth-remember {
    flex-direction: row;
    align-items: center;
    gap: 0.55rem;
    cursor: pointer;
    user-select: none;
  }
  .modal .auth-remember input {
    width: auto;
    padding: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .auth-error {
    color: #e07070;
    font-size: 0.82rem;
  }

  .auth-switch {
    margin-top: 1.25rem;
    font-size: 0.82rem;
    color: var(--text-dim);
    text-align: center;
  }

  .btn-discord {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    width: 100%;
    margin-top: 1.25rem;
    padding: 0.7rem;
    background: #5865f2;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .btn-discord:hover:not(:disabled) { opacity: 0.9; }
  .btn-discord:disabled { opacity: 0.6; cursor: not-allowed; }

  .auth-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1rem 0;
    color: var(--text-dim);
    font-size: 0.78rem;
  }
  .auth-divider::before,
  .auth-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  /* ── View toggle (icon buttons) ── */
  .view-toggle {
    gap: 4px;
  }
  .view-toggle-btn {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0.5rem 1.1rem;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s, background 0.2s, transform 0.2s;
    font: inherit;
  }
  .view-toggle-btn:hover {
    color: var(--accent);
    transform: translateY(-1px);
  }
  .view-toggle-btn.active {
    color: #000;
    background: var(--accent);
  }
  .view-toggle-btn.active:hover {
    color: #000;
    transform: none;
  }
  .view-toggle-btn svg {
    display: block;
  }

  /* ── Board layout ── */
  .feed {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .post {
    background: var(--bg2);
    border: 1.5px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.25rem;
    transition: border-color 0.2s;
  }
  .post:hover { border-color: rgba(255, 255, 255, 0.18); }

  .post-head {
    display: grid;
    grid-template-columns: 275px minmax(0, 1fr);
    gap: 1rem;
  }
  .post-thumb {
    position: relative;
    display: block;
    width: 275px;
    aspect-ratio: 16 / 11.25;
    border-radius: 6px;
    overflow: hidden;
    background: var(--bg2);
    border: 1.5px solid var(--border);
    padding: 0;
    cursor: pointer;
  }
  .post-thumb img {
    width: 100%; height: 100%;
    object-fit: contain;
    display: block;
  }
  .post-thumb img.censored { filter: blur(28px); }
  .reveal {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 0.25rem;
    background: rgba(0,0,0,0.5);
    border: none;
    color: #fff;
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .reveal strong {
    font-size: 0.78rem;
    padding: 0.35rem 0.85rem;
    border-radius: 999px;
    border: 1.5px solid var(--accent);
    background: rgba(0, 0, 0, 0.55);
    color: var(--accent);
    transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
  }
  .reveal:hover strong,
  .reveal:focus-visible strong {
    background: var(--accent);
    color: #000;
    transform: translateY(-1px);
  }
  .reveal:focus-visible { outline: none; }
  @media (prefers-reduced-motion: reduce) {
    .reveal strong { transition: none; }
    .reveal:hover strong,
    .reveal:focus-visible strong { transform: none; }
  }

  .post-body { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
  .post-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .post-author {
    background: none;
    border: none;
    color: var(--accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }
  .post-author:hover { text-decoration: underline; }
  .post-dot { color: var(--text-dim); }
  .post-tags { display: inline-flex; flex-wrap: wrap; gap: 0.35rem; }
  .post-tag {
    color: var(--text-dim);
    font-size: 0.78rem;
    padding: 0.1rem 0.45rem;
    border: none;
    border-radius: 4px;
    background: rgba(255,255,255,0.04);
    cursor: pointer;
    font: inherit;
    transition: all 0.15s;
  }
  .post-tag:hover { color: var(--accent); background: rgba(0,212,170,0.1); }

  .post-title {
    font-family: 'Fredoka', sans-serif;
    font-weight: 600;
    font-size: 1.1rem;
    color: var(--text);
    letter-spacing: -0.01em;
    line-height: 1.2;
  }
  .post-description {
    font-size: 0.88rem;
    line-height: 1.45;
    color: rgba(255, 255, 255, 0.78);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .lb-description {
    font-size: 0.88rem;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.78);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .post-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: auto;
    padding-top: 0.4rem;
    font-size: 0.82rem;
  }
  .like.board-like, .comments-count, .open-thread {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    color: var(--text-dim);
    font: inherit;
    cursor: pointer;
    padding: 4px 8px;
    margin: -4px -8px;
    min-height: 24px;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }
  .like.board-like:hover { color: #e07070; }
  .like.board-like.liked { color: #e07070; }
  .comments-count:hover { color: var(--accent); }
  .open-thread {
    margin-left: auto;
    color: var(--accent);
    font-weight: 600;
  }
  .open-thread:hover { background: rgba(0,212,170,0.1); }

  .thread-panel {
    margin-top: 0.9rem;
    padding-top: 0.8rem;
    border-top: 1px dashed var(--border);
  }
  .thread {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    margin-bottom: 0.6rem;
    padding: 0;
  }
  .reply {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.5rem;
    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--text-dim);
    padding-left: 0.5rem;
  }
  .reply-arrow { color: var(--text-dim); }
  .reply-author {
    color: var(--magenta);
    font-weight: 600;
    background: none;
    border: none;
    font: inherit;
    cursor: pointer;
    padding: 0;
  }
  .reply-author:hover { text-decoration: underline; }
  .reply-text {
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .reply-date { color: var(--text-dim); font-size: 0.72rem; }

  .more-comments {
    display: inline-flex;
    margin-bottom: 0.65rem;
    font-size: 0.82rem;
    color: var(--accent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    font: inherit;
  }
  .more-comments:hover { text-decoration: underline; }
  .more-comments:disabled { opacity: 0.6; cursor: default; }

  .thread-empty {
    font-size: 0.78rem;
    color: var(--text-dim);
    margin-bottom: 0.65rem;
  }

  .board-comment-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: center;
  }
  .board-comment-form input {
    min-width: 0;
    height: 36px;
    border: 1.5px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.84rem;
    padding: 0 0.7rem;
  }
  .board-comment-form input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 212, 170, 0.12);
  }
  .board-comment-form button {
    height: 36px;
    border: 1.5px solid var(--accent);
    border-radius: 4px;
    background: rgba(0, 212, 170, 0.12);
    color: var(--accent);
    font: inherit;
    font-size: 0.8rem;
    font-weight: 700;
    padding: 0 0.8rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, opacity 0.15s;
  }
  .board-comment-form button:hover:not(:disabled) {
    background: var(--accent);
    color: #000;
  }
  .board-comment-form button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
  .board-comment-error {
    margin-top: 0.4rem;
    color: #e07070;
    font-size: 0.8rem;
  }
  .login-to-comment {
    color: var(--text-dim);
    font-size: 0.82rem;
  }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    nav, header, main, footer { padding-left: 1.25rem; padding-right: 1.25rem; }
    header { padding-top: 1.5rem; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.75rem; }
    .nav-links { gap: 1rem; }
    .gallery-layout { grid-template-columns: 1fr; }
    .gallery-sidebar { position: static; }
    .lightbox-stage {
      grid-template-columns: 1fr;
      gap: 0.85rem;
    }
    .lightbox {
      grid-column: 1;
      width: 100%;
      min-height: 0;
      height: min(86vh, 760px);
    }
    .lightbox-stage > .lb-nav.prev,
    .lightbox-stage > .lb-nav.next {
      grid-column: 1;
      justify-self: center;
    }
    .lb-tags-row,
    .tag-editor-row,
    .lb-actions { flex-wrap: wrap; }
    .post-head { grid-template-columns: 150px minmax(0, 1fr); gap: 0.75rem; }
    .post-thumb { width: 150px; }
    .post-actions { flex-wrap: wrap; gap: 0.5rem; }
    .open-thread { margin-left: 0; }
  }

  .lightbox-stage:fullscreen {
    width: 100vw;
    height: 100vh;
    max-width: none;
    padding: 1.5rem 2rem;
    background: rgba(0, 0, 0, 0.96);
  }

  .lightbox-stage:fullscreen .lightbox {
    max-width: none;
    width: 100%;
    max-height: 100%;
    height: 100%;
    min-height: 0;
  }

  .lightbox-stage:fullscreen .lb-img-wrap,
  .lightbox-stage:fullscreen .lb-img-wrap img,
  .lightbox-stage:fullscreen .lb-timelapse {
    max-height: 100%;
  }
</style>
