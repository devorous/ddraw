<script>
  import { onMount } from 'svelte';

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
  const TOKEN_KEY = 'topDrawAuthToken';
  const USERNAME_KEY = 'topDrawUsername';
  const COMMENT_PREVIEW_LIMIT = 4;

  let items = $state([]);
  let commentsById = $state({});       // { [itemId]: comment[] }
  let commentCountsById = $state({});
  let commentDraftsById = $state({});
  let commentSubmittingById = $state({});
  let commentErrorsById = $state({});
  let loading = $state(true);
  let error = $state(null);
  let page = $state(1);
  let totalPages = $state(1);
  let sort = $state('newest');
  let topPeriod = $state('all');
  let tagFilter = $state(null);
  let sidebarTags = $state([]);
  const TAG_MAX_SHOWN = 12; // strip shows only the top 12 tags
  let sidebarLoading = $state(false);
  let likedIds = $state(new Set());
  let user = $state(null);
  let authLoading = $state(false);
  let authError = $state(null);
  let showAuthModal = $state(false);
  let authMode = $state('login');
  let authForm = $state({ username: '', password: '', email: '' });
  let revealed = $state(new Set());

  function authHeaders() {
    const token = localStorage.getItem(TOKEN_KEY);
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  async function checkAuth() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { user = null; return; }
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
      if (!res.ok) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USERNAME_KEY);
        user = null;
        return;
      }
      const data = await res.json();
      if (data.success) {
        user = { username: data.username, role: data.role, userId: data.userId };
        likedIds = new Set(Array.isArray(data.likedGalleryIds) ? data.likedGalleryIds : []);
      }
    } catch {}
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
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(USERNAME_KEY, data.username);
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
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(USERNAME_KEY, data.username);
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

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    user = null;
    likedIds = new Set();
  }

  async function fetchBoard() {
    loading = true;
    error = null;
    try {
      let url = `${API_BASE}/api/gallery?page=${page}&limit=12&sort=${sort}`;
      if (sort === 'top') url += `&period=${topPeriod}`;
      if (tagFilter) url += `&tag=${encodeURIComponent(tagFilter)}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      items = data.items;
      totalPages = data.pages;
      fetchAllComments(items);
    } catch {
      error = 'Could not load. Try again later.';
    } finally {
      loading = false;
    }
  }

  async function fetchSidebar() {
    sidebarLoading = true;
    try {
      let url = `${API_BASE}/api/gallery/sidebar`;
      if (tagFilter) url += `?tag=${encodeURIComponent(tagFilter)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('sidebar failed');
      const data = await res.json();
      sidebarTags = data.tags || [];
    } catch {
      sidebarTags = [];
    } finally {
      sidebarLoading = false;
    }
  }

  async function fetchAllComments(forItems) {
    const next = { ...commentsById };
    const nextCounts = { ...commentCountsById };
    await Promise.all(forItems.map(async (item) => {
      try {
        const res = await fetch(`${API_BASE}/api/gallery/${item.id}/comments`);
        if (!res.ok) return;
        const data = await res.json();
        const comments = data.comments || [];
        next[item.id] = comments.slice(-COMMENT_PREVIEW_LIMIT);
        nextCounts[item.id] = comments.length;
      } catch {}
    }));
    commentsById = next;
    commentCountsById = nextCounts;
  }

  function commentCountFor(item) {
    return commentCountsById[item.id] ?? item.commentsCount ?? commentsById[item.id]?.length ?? 0;
  }

  async function submitComment(item) {
    if (!user || commentSubmittingById[item.id]) return;
    const text = (commentDraftsById[item.id] || '').trim();
    if (!text) return;

    commentSubmittingById = { ...commentSubmittingById, [item.id]: true };
    commentErrorsById = { ...commentErrorsById, [item.id]: null };

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders()
        },
        body: JSON.stringify({ text })
      });
      if (!res.ok) throw new Error('comment failed');

      const comment = await res.json();
      const current = commentsById[item.id] || [];
      commentsById = {
        ...commentsById,
        [item.id]: [...current, comment].slice(-COMMENT_PREVIEW_LIMIT)
      };
      commentDraftsById = { ...commentDraftsById, [item.id]: '' };
      const nextCount = commentCountFor(item) + 1;
      commentCountsById = { ...commentCountsById, [item.id]: nextCount };
      items = items.map(i => i.id === item.id ? { ...i, commentsCount: nextCount } : i);
    } catch {
      commentErrorsById = { ...commentErrorsById, [item.id]: 'Could not post comment. Try again.' };
    } finally {
      commentSubmittingById = { ...commentSubmittingById, [item.id]: false };
    }
  }

  function isNsfw(item) { return !!item?.tags?.includes('nsfw'); }
  function isRevealed(item) { return revealed.has(item.id); }
  function reveal(item) { revealed = new Set([...revealed, item.id]); }

  async function toggleLike(item) {
    if (!user) {
      openAuthModal('login');
      return;
    }
    const wasLiked = likedIds.has(item.id);
    const next = new Set(likedIds);
    if (wasLiked) next.delete(item.id); else next.add(item.id);
    likedIds = next;
    items = items.map(i => i.id === item.id ? { ...i, likesCount: Math.max(0, (i.likesCount || 0) + (wasLiked ? -1 : 1)) } : i);
    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}/like`, { method: 'POST', headers: authHeaders() });
      if (!res.ok) throw new Error();
      const data = await res.json().catch(() => ({}));
      if (typeof data.likesCount === 'number') {
        items = items.map(i => i.id === item.id ? { ...i, likesCount: data.likesCount } : i);
      }
    } catch {
      // revert
      const rev = new Set(likedIds);
      if (wasLiked) rev.add(item.id); else rev.delete(item.id);
      likedIds = rev;
    }
  }

  function setSort(s) {
    if (s === sort) return;
    sort = s;
    page = 1;
    fetchBoard();
  }

  function filterByTag(tag) {
    tagFilter = tag;
    page = 1;
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', `/gallery/?tag=${encodeURIComponent(tag)}`);
    }
    fetchBoard();
    fetchSidebar();
  }

  function clearTagFilter() {
    tagFilter = null;
    page = 1;
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', '/gallery/');
    }
    fetchBoard();
    fetchSidebar();
  }

  function setTopPeriod(period) {
    if (period === topPeriod) return;
    topPeriod = period;
    if (sort !== 'top') sort = 'top';
    page = 1;
    fetchBoard();
  }

  function goPage(p) {
    if (p < 1 || p > totalPages || p === page) return;
    page = p;
    fetchBoard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function fmtDate(d) {
    return new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
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
    return fmtDate(d);
  }

  onMount(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tagParam = params.get('tag');
      if (tagParam) tagFilter = tagParam.trim().toLowerCase();
    }
    checkAuth();
    fetchBoard();
    fetchSidebar();
  });
</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">

<div class="page">
  <nav>
    <a href="/" class="wordmark">DDraw</a>
    <div class="nav-links">
      <span class="nav-active">gallery</span>
      <a href="/messenger/" class="nav-link">messenger</a>
      <a href="/go/" class="nav-enter" target="_blank">Draw Now! →</a>
      <span class="nav-divider">|</span>
      {#if user}
        <span class="nav-user">{user.username}</span>
        <button class="nav-auth-text" onclick={logout}>logout</button>
      {:else}
        <button class="nav-login" onclick={() => openAuthModal('login')}>Log in</button>
      {/if}
    </div>
  </nav>

  <header>
    <div class="header-layout">
      <div class="header-main">
        <h1 class="ggallery">GGallery</h1>
        <p class="board-tag">
          {#if tagFilter}
            <span>{tagFilter}</span>
            <button class="clear-tag" onclick={clearTagFilter}>clear</button>
          {:else}
            Board view
          {/if}
          <span class="badge">default</span>
        </p>
        <div class="view-toggle" aria-label="Gallery view">
          <span class="active">Board</span>
          <a href="/gallery/grid/">Grid</a>
        </div>
        <div class="sorts">
          <button class:active={sort === 'newest'} onclick={() => setSort('newest')}>Newest</button>
          <button class:active={sort === 'active'} onclick={() => setSort('active')}>Active</button>
          <button class:active={sort === 'top'} onclick={() => setSort('top')}>Top</button>
          <button class:active={sort === 'views'} onclick={() => setSort('views')}>Views</button>
        </div>
        {#if sort === 'top'}
          <div class="top-periods" aria-label="Top time range">
            <button class:active={topPeriod === 'week'} onclick={() => setTopPeriod('week')}>Week</button>
            <button class:active={topPeriod === 'month'} onclick={() => setTopPeriod('month')}>Month</button>
            <button class:active={topPeriod === 'year'} onclick={() => setTopPeriod('year')}>Year</button>
            <button class:active={topPeriod === 'all'} onclick={() => setTopPeriod('all')}>All time</button>
          </div>
        {/if}
      </div>

      <section class="tag-strip" aria-label="Image tags">
        <div class="tag-strip-head">
          <h2>Image Tags</h2>
          {#if tagFilter}
            <button class="clear-tag" onclick={clearTagFilter}>clear</button>
          {/if}
        </div>
        {#if sidebarTags.length === 0}
          <p class="tag-strip-empty">{sidebarLoading ? 'Loading tags...' : 'No tags yet'}</p>
        {:else}
          <div class="tag-strip-list">
            {#each sidebarTags.slice(0, TAG_MAX_SHOWN) as entry}
              <button class="tag-chip" class:active={tagFilter === entry.tag} onclick={() => filterByTag(entry.tag)}>
                {entry.tag} <span>{entry.count}</span>
              </button>
            {/each}
            {#if sidebarTags.length > TAG_MAX_SHOWN}
              <span class="tag-more">...</span>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  </header>

  <main>
    {#if loading}
      <div class="state"><div class="spinner"></div></div>
    {:else if error}
      <div class="state"><p>{error}</p></div>
    {:else if items.length === 0}
      <div class="state"><p>No posts yet.</p></div>
    {:else}
      <div class="feed">
        {#each items as item (item.id)}
          <article class="post">
            <div class="post-head">
              <a class="post-thumb" href={`/gallery/${item.id}`}>
                <img
                  src={item.thumbUrl || item.url}
                  alt={item.title || 'artwork'}
                  loading="lazy"
                  class:censored={isNsfw(item) && !isRevealed(item)}
                />
                {#if isNsfw(item) && !isRevealed(item)}
                  <button class="reveal" onclick={(e) => { e.preventDefault(); reveal(item); }}>
                    <span>NSFW</span><strong>Reveal</strong>
                  </button>
                {/if}
              </a>

              <div class="post-body">
                <div class="post-meta">
                  <span class="post-author">{item.author}</span>
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
                <div class="post-actions">
                  <button class="like" class:liked={likedIds.has(item.id)} onclick={() => toggleLike(item)}>
                    <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1.24 8.24L8 15l6.76-6.76A4.76 4.76 0 0016 5.24v-.19A4.05 4.05 0 0011.95 1c-1.23 0-2.4.56-3.17 1.52L8 3.5l-.78-.98A4.05 4.05 0 004.05 1 4.05 4.05 0 000 5.05v.19c0 1.13.45 2.21 1.24 3z"/></svg>
                    {item.likesCount || 0}
                  </button>
                  <a class="comments-count" href={`/gallery/${item.id}`}>
                    <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M14 1H2a1 1 0 00-1 1v9a1 1 0 001 1h2v3l3-3h7a1 1 0 001-1V2a1 1 0 00-1-1z"/></svg>
                    {commentCountFor(item)}
                  </a>
                  <a class="open-thread" href={`/gallery/${item.id}`}>Open thread →</a>
                </div>
              </div>
            </div>

            <div class="thread-panel">
              {#if commentsById[item.id]?.length}
                <ul class="thread">
                  {#each commentsById[item.id] as c}
                    <li class="reply">
                      <span class="reply-arrow">↳</span>
                      <span class="reply-author">{c.author}:</span>
                      <span class="reply-text">{c.text}</span>
                      <span class="reply-date">{shortDate(c.createdAt)}</span>
                    </li>
                  {/each}
                </ul>
                {#if commentCountFor(item) > commentsById[item.id].length}
                  <a class="more-comments" href={`/gallery/${item.id}`}>... view all comments</a>
                {/if}
              {/if}

              {#if user}
                <form class="comment-form" onsubmit={(e) => { e.preventDefault(); submitComment(item); }}>
                  <input
                    type="text"
                    bind:value={commentDraftsById[item.id]}
                    placeholder="Add a comment..."
                    maxlength="500"
                    disabled={commentSubmittingById[item.id]}
                  />
                  <button type="submit" disabled={!commentDraftsById[item.id]?.trim() || commentSubmittingById[item.id]}>
                    {commentSubmittingById[item.id] ? '...' : 'Post'}
                  </button>
                </form>
                {#if commentErrorsById[item.id]}
                  <p class="comment-error">{commentErrorsById[item.id]}</p>
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

      {#if totalPages > 1}
        <div class="pagination">
          <button onclick={() => goPage(page - 1)} disabled={page <= 1}>←</button>
          <span>Page {page} of {totalPages}</span>
          <button onclick={() => goPage(page + 1)} disabled={page >= totalPages}>→</button>
        </div>
      {/if}
    {/if}
  </main>

  <footer>
    <span>DDraw · GGallery board</span>
    <a href="/gallery/grid/">← classic grid view</a>
  </footer>
</div>

{#if showAuthModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" role="presentation" onclick={closeAuthModal} onkeydown={(e) => e.key === 'Escape' && closeAuthModal()}>
    <div class="modal" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      <button class="modal-close" onclick={closeAuthModal}>×</button>
      <h2>{authMode === 'login' ? 'Login' : 'Register'}</h2>

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

        {#if authError}
          <p class="auth-error">{authError}</p>
        {/if}

        <button type="submit" class="btn-primary" disabled={authLoading}>
          {authLoading ? '...' : (authMode === 'login' ? 'Login' : 'Register')}
        </button>
      </form>

      <p class="auth-switch">
        {#if authMode === 'login'}
          Don't have an account? <button class="btn-link" onclick={() => { authMode = 'register'; authError = null; }}>Register</button>
        {:else}
          Already have an account? <button class="btn-link" onclick={() => { authMode = 'login'; authError = null; }}>Login</button>
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
    overflow-x: hidden;
  }
  :global(a) { color: inherit; text-decoration: none; }

  :global(body)::before {
    content: '';
    position: fixed; inset: 0;
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
    --bg3: #232328;
    --text: #ffffff;
    --text-dim: rgba(255,255,255,0.7);
    --text-muted: rgba(255,255,255,0.45);
    --accent: #00d4aa;
    --magenta: #c800c8;
    --yellow: #ffdd00;
    --border: rgba(255,255,255,0.1);
  }

  .page { min-height: 100vh; display: flex; flex-direction: column; position: relative; z-index: 1; }

  nav {
    position: sticky;
    top: 0; z-index: 50;
    display: flex; align-items: center; justify-content: space-between;
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
  .nav-links a { color: var(--text-dim); transition: color 0.2s, transform 0.2s; }
  .nav-links a:hover { color: var(--accent); transform: translateY(-1px); }
  .nav-active { color: var(--text-muted); }
  .nav-divider { color: var(--border); }
  .nav-user {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-weight: 600;
    letter-spacing: 0;
  }
  .nav-auth-text {
    background: none;
    border: none;
    color: var(--text-dim);
    font: inherit;
    cursor: pointer;
    padding: 0;
    transition: color 0.2s, transform 0.2s;
  }
  .nav-auth-text:hover {
    color: var(--accent);
    transform: translateY(-1px);
  }
  .nav-login {
    background: var(--magenta);
    border: none;
    color: #fff !important;
    padding: 0.5rem 0.95rem;
    border-radius: 50px;
    font-weight: 700;
    font: inherit;
    cursor: pointer;
  }
  .nav-login:hover {
    color: #fff !important;
    transform: translateY(-1px) scale(1.03);
  }
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

  header {
    padding: 2.5rem 3rem 1.5rem;
    border-bottom: 2px solid var(--border);
    max-width: 1040px;
    margin: 0 auto;
    width: 100%;
  }
  .header-layout {
    display: grid;
    grid-template-columns: minmax(280px, 0.72fr) minmax(420px, 1fr);
    gap: 1.5rem;
    align-items: start;
  }
  .header-main {
    min-width: 0;
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
    margin-bottom: 0.8rem;
  }
  .board-tag {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin-bottom: 1.2rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .clear-tag {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
    padding: 0;
  }
  .clear-tag:hover { text-decoration: underline; }
  .badge {
    background: var(--magenta);
    color: #fff;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    letter-spacing: 0.05em;
  }

  .view-toggle {
    display: inline-flex;
    align-items: center;
    padding: 3px;
    margin-bottom: 0.75rem;
    border: 1.5px solid var(--border);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.035);
  }
  .view-toggle a,
  .view-toggle span {
    min-width: 76px;
    padding: 0.42rem 0.8rem;
    border-radius: 4px;
    color: var(--text-dim);
    font-size: 0.8rem;
    font-weight: 600;
    text-align: center;
    transition: color 0.2s, background 0.2s, transform 0.2s;
  }
  .view-toggle a:hover {
    color: var(--accent);
    transform: translateY(-1px);
  }
  .view-toggle .active {
    color: #000;
    background: var(--accent);
  }

  .sorts, .top-periods { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .top-periods {
    margin-top: 0.65rem;
  }
  .sorts button, .top-periods button {
    background: none;
    border: 2px solid var(--border);
    color: var(--text-dim);
    font: inherit;
    font-size: 0.8rem;
    padding: 0.4rem 0.9rem;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .top-periods button {
    border-width: 1.5px;
    font-size: 0.74rem;
    padding: 0.3rem 0.7rem;
  }
  .sorts button:hover, .top-periods button:hover { border-color: var(--accent); color: var(--accent); }
  .sorts button.active, .top-periods button.active {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(0, 212, 170, 0.1);
  }

  .tag-strip {
    align-self: stretch;
    padding: 0.85rem;
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
    color: var(--text-muted);
    font-size: 0.82rem;
  }
  .tag-strip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }
  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-dim);
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.28rem 0.6rem;
    transition: color 0.15s, background 0.15s, border-color 0.15s;
  }
  .tag-chip span {
    color: var(--text-muted);
    font-size: 0.72rem;
  }
  .tag-chip:hover, .tag-chip.active {
    border-color: rgba(0,212,170,0.45);
    color: var(--accent);
    background: rgba(0,212,170,0.1);
  }
  .tag-more {
    align-self: center;
    color: var(--text-muted);
    font-size: 0.9rem;
    padding: 0 0.25rem;
  }

  main {
    flex: 1;
    padding: 1.5rem 3rem 3rem;
    max-width: 880px;
    margin: 0 auto;
    width: 100%;
  }

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
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 1rem;
  }
  .post-thumb {
    position: relative;
    display: block;
    width: 220px;
    aspect-ratio: 16 / 9;
    border-radius: 6px;
    overflow: hidden;
    background: var(--bg3);
    border: 1.5px solid var(--border);
  }
  .post-thumb img {
    width: 100%; height: 100%;
    object-fit: contain;
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
    color: var(--text-muted);
  }
  .post-author { color: var(--accent); font-weight: 600; }
  .post-dot { color: var(--text-muted); }
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

  .post-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: auto;
    padding-top: 0.4rem;
    font-size: 0.82rem;
  }
  .like, .comments-count, .open-thread {
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
  .like:hover { color: #e07070; }
  .like.liked { color: #e07070; }
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
  .reply-arrow { color: var(--text-muted); }
  .reply-author { color: var(--magenta); font-weight: 600; }
  .reply-text {
    color: var(--text);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .reply-date { color: var(--text-muted); font-size: 0.72rem; }

  .more-comments {
    display: inline-flex;
    margin-bottom: 0.65rem;
    font-size: 0.82rem;
    color: var(--accent);
  }
  .more-comments:hover { text-decoration: underline; }

  .comment-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: center;
  }
  .comment-form input {
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
  .comment-form input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(0, 212, 170, 0.12);
  }
  .comment-form button {
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
  .comment-form button:hover:not(:disabled) {
    background: var(--accent);
    color: #000;
  }
  .comment-form button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
  .btn-primary {
    display: inline-block;
    padding: 0.7rem 1.75rem;
    background: var(--accent);
    color: #0f0f13;
    font-family: inherit;
    font-weight: 600;
    font-size: 0.88rem;
    letter-spacing: 0.04em;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-primary:hover:not(:disabled) {
    background: #00f0c3;
    transform: translateY(-2px);
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn-link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    padding: 0;
    text-decoration: underline;
  }
  .login-to-comment, .comment-error {
    color: var(--text-muted);
    font-size: 0.82rem;
  }
  .comment-error {
    margin-top: 0.4rem;
    color: #e07070;
  }

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
    top: 0.75rem;
    right: 0.75rem;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 1.2rem;
    cursor: pointer;
  }
  .modal-close:hover { color: var(--text); }
  .modal h2 {
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

  .state {
    min-height: 40vh;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-muted);
  }
  .spinner {
    width: 28px; height: 28px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slideUp { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  .pagination {
    margin-top: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .pagination button {
    background: none;
    border: 2px solid var(--border);
    color: var(--text-dim);
    font: inherit;
    padding: 0.4rem 0.9rem;
    border-radius: 4px;
    cursor: pointer;
    min-width: 40px;
    transition: all 0.2s;
  }
  .pagination button:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .pagination button:disabled { opacity: 0.4; cursor: not-allowed; }

  footer {
    padding: 2rem 3rem;
    border-top: 2px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-muted);
    font-size: 0.85rem;
    max-width: 880px;
    margin: 0 auto;
    width: 100%;
  }
  footer a { color: var(--text-dim); }
  footer a:hover { color: var(--accent); }

  @media (max-width: 640px) {
    header, main, footer { padding-left: 1.25rem; padding-right: 1.25rem; }
    .header-layout { grid-template-columns: 1fr; gap: 1rem; }
    .post-head { grid-template-columns: 120px minmax(0, 1fr); gap: 0.75rem; }
    .post-thumb { width: 120px; }
    .post-actions { flex-wrap: wrap; gap: 0.5rem; }
    .open-thread { margin-left: 0; }
  }
</style>
