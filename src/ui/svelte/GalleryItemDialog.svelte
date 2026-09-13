<script>
  import { appState, showProfile } from '../../state.svelte.js';

  let { apiBaseUrl = '', galleryBaseUrl = '/gallery', onClose = null } = $props();

  let visible = $derived(appState.galleryItemDialog.visible);
  let itemId = $derived(appState.galleryItemDialog.itemId);
  let item = $state(null);
  let loading = $state(false);
  let error = $state(null);
  let liked = $state(false);
  let likesCount = $state(0);

  async function fetchItem() {
    if (!itemId) return;

    loading = true;
    error = null;
    item = null;

    async function tryFetchJson(url) {
      try {
        const token = localStorage.getItem('topDrawAuthToken');
        const res = await fetch(url, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) return null;
        return await res.json();
      } catch {
        return null;
      }
    }

    try {
      const data =
        (await tryFetchJson(`${apiBaseUrl}/api/gallery/${itemId}`)) ||
        (await tryFetchJson(`${apiBaseUrl}/api/gallery-item?id=${encodeURIComponent(itemId)}`));
      if (!data) throw new Error('Failed to load image');

      item = data;
      likesCount = data.likesCount || 0;
      liked = !!(data.liked || data.likedByCurrentUser);
    } catch (err) {
      console.error('[GalleryItemDialog] Fetch error:', err);
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function handleLike() {
    if (!item) return;
    const token = localStorage.getItem('topDrawAuthToken');
    if (!token) return;

    const prevLiked = liked;
    const prevCount = likesCount;

    liked = !liked;
    likesCount += liked ? 1 : -1;

    try {
      const res = await fetch(`${apiBaseUrl}/api/gallery/${item.id}/like`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!res.ok) throw new Error('Failed to like image');

      const data = await res.json();
      liked = data.liked;
      likesCount = data.likesCount;

    } catch (err) {
      console.error('[GalleryItemDialog] Like error:', err);
      liked = prevLiked;
      likesCount = prevCount;
    }
  }

  function close() {
    appState.galleryItemDialog = {
      visible: false,
      itemId: null
    };
    if (onClose) onClose();
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) {
      close();
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      close();
    }
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  // Fetch item when dialog opens
  $effect(() => {
    if (visible && itemId) {
      fetchItem();
    }
  });
</script>

{#if visible}
  <div
    class="gallery-item-dialog-backdrop"
    onclick={handleBackdropClick}
    onkeydown={handleKeyDown}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="gallery-item-dialog">
      <button class="close-btn" onclick={close} aria-label="Close">×</button>

      {#if loading}
        <div class="loading">Loading...</div>
      {:else if error}
        <div class="error">Error: {error}</div>
      {:else if item}
        <div class="dialog-content">
          <div class="image-container">
            <img src={item.url} alt={item.title || 'Gallery image'} />
          </div>

          <div class="info-panel">
            <h2 class="title">{item.title || 'Untitled'}</h2>

            <div class="meta">
              <span class="author">by
                {#if item.authorHasProfile && item.author}
                  <button
                    type="button"
                    class="author-link"
                    title={`View ${item.author}'s profile`}
                    onclick={() => showProfile(item.author)}
                  >{item.author}</button>
                {:else}
                  <strong>{item.author || 'Anonymous'}</strong>
                {/if}
              </span>
              <span class="date">{formatDate(item.createdAt)}</span>
            </div>

            {#if item.tags && item.tags.length > 0}
              <div class="tags">
                {#each item.tags as tag}
                  <span class="tag">{tag}</span>
                {/each}
              </div>
            {/if}

            <div class="actions">
              <button
                class="action-btn like-btn"
                class:liked={liked}
                onclick={handleLike}
              >
                <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 14L7.2 13.3C3.4 9.9 1 7.7 1 5C1 2.8 2.8 1 5 1C6.4 1 7.7 1.7 8 2.8C8.3 1.7 9.6 1 11 1C13.2 1 15 2.8 15 5C15 7.7 12.6 9.9 8.8 13.3L8 14Z"
                    fill={liked ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    stroke-width="1.5"
                  />
                </svg>
                <span>{likesCount}</span>
              </button>

              <div class="stats">
                <span class="stat">
                <!---
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M1 8C1 8 3.5 3 8 3C12.5 3 15 8 15 8C15 8 12.5 13 8 13C3.5 13 1 8 1 8Z" stroke="currentColor" stroke-width="1.5"/>
                    <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/>
                  </svg>
                  {item.views || 0} views -->
                </span>
              </div>
            </div>

            <div class="footer">
              <a href="{galleryBaseUrl}/{encodeURIComponent(item.id)}" target="_blank" class="view-full-btn">
                View in Gallery →
              </a>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .gallery-item-dialog-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .gallery-item-dialog {
    position: relative;
    background: var(--color-bg-primary, #1a1d23);
    border-radius: 12px;
    max-width: 90vw;
    max-height: 90vh;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    animation: slideUp 0.3s ease-out;
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .close-btn {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    z-index: 10;
    transition: background 0.2s;
  }

  .close-btn:hover {
    background: rgba(0, 0, 0, 0.8);
  }

  .loading, .error {
    padding: 60px;
    text-align: center;
    color: var(--color-text-secondary, #aaa);
  }

  .error {
    color: #ff6b6b;
  }

  .dialog-content {
    display: flex;
    gap: 0;
    max-height: 90vh;
  }

  .image-container {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-tertiary, #0a0c0f);
    min-width: 400px;
    max-width: 60vw;
  }

  .image-container img {
    max-width: 100%;
    max-height: 90vh;
    object-fit: contain;
    display: block;
  }

  .info-panel {
    width: 320px;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: var(--color-bg-secondary, #1f2228);
    overflow-y: auto;
  }

  .title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--color-text-primary, #f0f2f5);
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 14px;
    color: var(--color-text-secondary, #aaa);
  }

  .author strong,
  .author-link {
    color: var(--color-accent, #00d4aa);
    font-weight: 700;
  }

  .author-link {
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .author-link:hover,
  .author-link:focus-visible {
    text-decoration: underline;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .tag {
    padding: 4px 10px;
    background: var(--color-bg-tertiary, #0a0c0f);
    border-radius: 4px;
    font-size: 12px;
    color: var(--color-text-secondary, #aaa);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 16px;
    padding-top: 8px;
  }

  .action-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border: 1px solid var(--color-border, #333);
    border-radius: 6px;
    background: var(--color-bg-primary, #1a1d23);
    color: var(--color-text-secondary, #aaa);
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    transition: all 0.2s;
  }

  .action-btn:hover {
    background: var(--color-bg-hover, #2a2d35);
    border-color: var(--color-accent, #00d4aa);
  }

  .like-btn.liked {
    color: #ff6b6b;
    border-color: #ff6b6b;
  }

  .stats {
    display: flex;
    gap: 12px;
    font-size: 13px;
    color: var(--color-text-secondary, #aaa);
  }

  .stat {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .footer {
    margin-top: auto;
    padding-top: 16px;
    border-top: 1px solid var(--color-border, #333);
  }

  .view-full-btn {
    display: inline-block;
    padding: 10px 16px;
    background: var(--color-accent, #00d4aa);
    color: var(--color-bg-primary, #1a1d23);
    text-decoration: none;
    border-radius: 6px;
    font-weight: 600;
    font-size: 14px;
    transition: opacity 0.2s;
  }

  .view-full-btn:hover {
    opacity: 0.9;
  }

  @media (max-width: 800px) {
    .dialog-content {
      flex-direction: column;
    }

    .image-container {
      min-width: auto;
      max-width: 100%;
    }

    .info-panel {
      width: 100%;
    }
  }
</style>
