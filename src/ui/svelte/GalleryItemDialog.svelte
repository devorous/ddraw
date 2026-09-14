<script>
  import { appState, showProfile } from '../../state.svelte.js';

  // Matches the server's check for deleting someone else's comment
  const DELETE_ANY_COMMENT_ROLE = 8;
  const DELETE_CONFIRM_MS = 3000;

  let { apiBaseUrl = '', galleryBaseUrl = '/gallery', onClose = null, onCommentsCountChange = null } = $props();

  let visible = $derived(appState.galleryItemDialog.visible);
  let itemId = $derived(appState.galleryItemDialog.itemId);
  let focusComments = $derived(!!appState.galleryItemDialog.focusComments);
  let item = $state(null);
  let loading = $state(false);
  let error = $state(null);
  let liked = $state(false);
  let likesCount = $state(0);

  let comments = $state([]);
  let commentsTotal = $state(0);
  let commentsLoading = $state(false);
  let commentError = $state(null);
  let newComment = $state('');
  let commentSubmitting = $state(false);
  let editingCommentId = $state(null);
  let editingCommentText = $state('');
  let commentActionBusy = $state(false);
  let pendingDeleteId = $state(null);
  let viewer = $state(null); // { userId, role } when signed in
  let viewerChecked = $state(false);
  let commentsSection = $state(null);
  let commentInput = $state(null);
  let deleteConfirmTimer = null;
  let focusedForId = null;
  // Bumped each time the dialog opens on a piece, so a slow response for the last one can't land on this one
  let loadSeq = 0;

  function readToken() {
    try {
      return localStorage.getItem('topDrawAuthToken');
    } catch {
      return null;
    }
  }

  async function fetchItem(seq) {
    if (!itemId) return;

    loading = true;
    error = null;
    item = null;

    async function tryFetchJson(url) {
      try {
        const token = readToken();
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
      if (seq !== loadSeq) return;
      if (!data) throw new Error('Failed to load image');

      item = data;
      likesCount = data.likesCount || 0;
      liked = !!(data.liked || data.likedByCurrentUser);
    } catch (err) {
      console.error('[GalleryItemDialog] Fetch error:', err);
      error = err.message;
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  function setCommentsTotal(id, total) {
    commentsTotal = Math.max(0, total);
    onCommentsCountChange?.(id, commentsTotal);
  }

  async function fetchComments(id, seq) {
    commentsLoading = true;
    commentError = null;
    comments = [];
    commentsTotal = 0;
    try {
      const res = await fetch(`${apiBaseUrl}/api/gallery/${id}/comments`);
      if (!res.ok) throw new Error('Could not load comments');
      const data = await res.json();
      if (seq !== loadSeq) return;
      comments = Array.isArray(data.comments) ? data.comments : [];
      setCommentsTotal(id, typeof data.total === 'number' ? data.total : comments.length);
    } catch (err) {
      if (seq === loadSeq) commentError = err.message || 'Could not load comments';
    } finally {
      if (seq === loadSeq) commentsLoading = false;
    }
  }

  async function fetchViewer(seq) {
    const token = readToken();
    if (!token) {
      viewer = null;
      viewerChecked = true;
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = res.ok ? await res.json() : null;
      if (seq !== loadSeq) return;
      viewer = data?.success ? { userId: data.userId, role: data.role || 0 } : null;
    } catch {
      // Offline for a moment: keep whatever we knew
    } finally {
      if (seq === loadSeq) viewerChecked = true;
    }
  }

  async function handleLike() {
    if (!item) return;
    const token = readToken();
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

  async function submitComment() {
    const text = newComment.trim();
    const token = readToken();
    if (!item || !text || commentSubmitting || !token) return;

    const id = item.id;
    commentSubmitting = true;
    commentError = null;
    try {
      const res = await fetch(`${apiBaseUrl}/api/gallery/${id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not post comment');
      if (item?.id !== id) return;
      comments = [...comments, { ...data, edited: !!data.updatedAt }];
      newComment = '';
      setCommentsTotal(id, commentsTotal + 1);
    } catch (err) {
      if (item?.id === id) commentError = err.message || 'Could not post comment';
    } finally {
      commentSubmitting = false;
    }
  }

  function canEditComment(comment) {
    return !!viewer && viewer.userId === comment.authorId;
  }

  function canDeleteComment(comment) {
    return !!viewer && (viewer.userId === comment.authorId || viewer.role >= DELETE_ANY_COMMENT_ROLE);
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
    const token = readToken();
    const text = editingCommentText.trim();
    const comment = comments.find((entry) => entry.id === commentId);
    if (!token || !comment || !canEditComment(comment) || !text || commentActionBusy) return;

    commentActionBusy = true;
    commentError = null;
    try {
      const res = await fetch(`${apiBaseUrl}/api/gallery/comments/${commentId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save comment');
      comments = comments.map((entry) => entry.id === commentId ? {
        ...entry,
        text: data.text || text,
        edited: true,
        updatedAt: data.updatedAt || new Date().toISOString()
      } : entry);
      cancelCommentEdit();
    } catch (err) {
      commentError = err.message || 'Could not save comment';
    } finally {
      commentActionBusy = false;
    }
  }

  // Two taps, like hiding a floating card: the first arms, the second deletes
  async function deleteComment(commentId) {
    const comment = comments.find((entry) => entry.id === commentId);
    if (!comment || !canDeleteComment(comment) || commentActionBusy) return;

    if (pendingDeleteId !== commentId) {
      pendingDeleteId = commentId;
      clearTimeout(deleteConfirmTimer);
      deleteConfirmTimer = setTimeout(() => { pendingDeleteId = null; }, DELETE_CONFIRM_MS);
      return;
    }
    clearTimeout(deleteConfirmTimer);
    pendingDeleteId = null;

    const token = readToken();
    if (!token || !item) return;
    const id = item.id;

    commentActionBusy = true;
    commentError = null;
    try {
      const res = await fetch(`${apiBaseUrl}/api/gallery/comments/${commentId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not delete comment');
      }
      if (item?.id !== id) return;
      comments = comments.filter((entry) => entry.id !== commentId);
      if (editingCommentId === commentId) cancelCommentEdit();
      setCommentsTotal(id, commentsTotal - 1);
    } catch (err) {
      commentError = err.message || 'Could not delete comment';
    } finally {
      commentActionBusy = false;
    }
  }

  function resetComments() {
    comments = [];
    commentsTotal = 0;
    commentError = null;
    newComment = '';
    pendingDeleteId = null;
    clearTimeout(deleteConfirmTimer);
    cancelCommentEdit();
  }

  function close() {
    appState.galleryItemDialog = {
      visible: false,
      itemId: null,
      focusComments: false
    };
    resetComments();
    focusedForId = null;
    if (onClose) onClose();
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) {
      close();
    }
  }

  function handleKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (editingCommentId) {
      cancelCommentEdit();
      return;
    }
    close();
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
      const seq = ++loadSeq;
      resetComments();
      viewerChecked = false;
      fetchItem(seq);
      fetchComments(itemId, seq);
      fetchViewer(seq);
    }
  });

  // Opened from a card's comment button: bring the comments into view once, and put the caret in
  // the box on devices with a real pointer (on touch that would pop the keyboard over the art)
  $effect(() => {
    if (!visible || !focusComments || !item || !commentsSection || focusedForId === item.id) return;
    const wantsCaret = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    if (wantsCaret && !viewerChecked) return; // the comment box appears once we know who's signed in
    focusedForId = item.id;
    if (wantsCaret && commentInput) {
      commentInput.focus({ preventScroll: true });
    }
    commentsSection.scrollIntoView({ block: 'nearest' });
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

            <section class="comments" bind:this={commentsSection} aria-label="Comments">
              <h3 class="comments-heading">
                Comments
                {#if commentsTotal}<span class="comments-total">{commentsTotal}</span>{/if}
              </h3>

              {#if commentsLoading}
                <p class="comments-note">Loading comments...</p>
              {:else if comments.length === 0}
                <p class="comments-note">No comments yet</p>
              {:else}
                <ul class="comments-list">
                  {#each comments as comment (comment.id)}
                    <li class="comment">
                      <div class="comment-header">
                        <button
                          type="button"
                          class="comment-author"
                          title={`View ${comment.author}'s profile`}
                          onclick={() => showProfile(comment.author)}
                        >{comment.author}</button>
                        <span class="comment-date">{formatDate(comment.createdAt)}</span>
                        {#if comment.edited}
                          <span class="comment-edited">edited</span>
                        {/if}
                        <span class="comment-tools">
                          {#if canEditComment(comment) && editingCommentId !== comment.id}
                            <button
                              type="button"
                              class="comment-action"
                              onclick={() => beginCommentEdit(comment)}
                              disabled={commentActionBusy}
                            >Edit</button>
                          {/if}
                          {#if canDeleteComment(comment)}
                            <button
                              type="button"
                              class="comment-action comment-delete"
                              class:confirm={pendingDeleteId === comment.id}
                              onclick={() => deleteComment(comment.id)}
                              disabled={commentActionBusy}
                              title={pendingDeleteId === comment.id ? 'Click again to delete' : 'Delete comment'}
                              aria-label="Delete comment"
                            >{pendingDeleteId === comment.id ? 'Delete?' : '×'}</button>
                          {/if}
                        </span>
                      </div>
                      {#if editingCommentId === comment.id}
                        <form class="comment-form" onsubmit={(e) => { e.preventDefault(); saveCommentEdit(comment.id); }}>
                          <input
                            type="text"
                            bind:value={editingCommentText}
                            maxlength="500"
                            readonly={commentActionBusy}
                            aria-label="Edit comment"
                          />
                          <button type="submit" class="comment-submit" disabled={!editingCommentText.trim() || commentActionBusy}>Save</button>
                          <button type="button" class="comment-action" onclick={cancelCommentEdit} disabled={commentActionBusy}>Cancel</button>
                        </form>
                      {:else}
                        <p class="comment-text">{comment.text}</p>
                      {/if}
                    </li>
                  {/each}
                </ul>
                {#if commentsTotal > comments.length}
                  <p class="comments-note">Showing the first {comments.length} of {commentsTotal}</p>
                {/if}
              {/if}

              {#if viewer}
                <form class="comment-form" onsubmit={(e) => { e.preventDefault(); submitComment(); }}>
                  <input
                    bind:this={commentInput}
                    type="text"
                    bind:value={newComment}
                    placeholder="Add a comment..."
                    maxlength="500"
                    readonly={commentSubmitting}
                    aria-label="Add a comment"
                  />
                  <button type="submit" class="comment-submit" disabled={!newComment.trim() || commentSubmitting}>
                    {commentSubmitting ? '...' : 'Post'}
                  </button>
                </form>
              {:else if !commentsLoading}
                <p class="comments-note">Log in to leave a comment</p>
              {/if}

              {#if commentError}
                <p class="comment-error" role="alert">{commentError}</p>
              {/if}
            </section>

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

  .comments {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 16px;
    border-top: 1px solid var(--color-border, #333);
  }

  .comments-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-primary, #f0f2f5);
  }

  .comments-total {
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--color-bg-tertiary, #0a0c0f);
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-secondary, #aaa);
  }

  .comments-note {
    margin: 0;
    font-size: 13px;
    color: var(--color-text-secondary, #aaa);
  }

  .comments-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .comment {
    padding: 8px 0;
    border-bottom: 1px solid var(--color-border, #333);
  }

  .comment:last-child {
    border-bottom: none;
  }

  .comment-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    font-size: 12px;
    color: var(--color-text-secondary, #aaa);
  }

  .comment-author {
    min-width: 0;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-weight: 700;
    color: var(--color-accent, #00d4aa);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .comment-author:hover,
  .comment-author:focus-visible {
    text-decoration: underline;
  }

  .comment-date,
  .comment-edited {
    flex-shrink: 0;
  }

  .comment-edited {
    font-style: italic;
  }

  .comment-tools {
    display: flex;
    gap: 4px;
    margin-left: auto;
    flex-shrink: 0;
  }

  .comment-action {
    padding: 2px 6px;
    border: none;
    border-radius: 4px;
    background: none;
    font: inherit;
    font-size: 12px;
    color: var(--color-text-secondary, #aaa);
    cursor: pointer;
  }

  .comment-action:hover:not(:disabled) {
    background: var(--color-bg-hover, #2a2d35);
    color: var(--color-text-primary, #f0f2f5);
  }

  .comment-delete {
    font-size: 15px;
    line-height: 1;
  }

  .comment-delete:hover:not(:disabled),
  .comment-delete.confirm {
    background: #b3261e;
    color: #fff;
    font-size: 12px;
  }

  .comment-action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .comment-text {
    margin: 4px 0 0;
    font-size: 14px;
    line-height: 1.4;
    color: var(--color-text-primary, #f0f2f5);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .comment-form {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }

  .comment-form input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--color-border, #333);
    border-radius: 6px;
    background: var(--color-bg-primary, #1a1d23);
    color: var(--color-text-primary, #f0f2f5);
    font: inherit;
    font-size: 14px;
  }

  .comment-form input:focus {
    outline: none;
    border-color: var(--color-accent, #00d4aa);
  }

  .comment-submit {
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    background: var(--color-accent, #00d4aa);
    color: var(--color-bg-primary, #1a1d23);
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
  }

  .comment-submit:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .comment-error {
    margin: 0;
    font-size: 13px;
    color: #ff6b6b;
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
      /* Stacked, the comments sit under the art: scroll the whole dialog to reach them */
      overflow-y: auto;
    }

    .image-container {
      min-width: auto;
      max-width: 100%;
    }

    .image-container img {
      max-height: 50vh;
    }

    .info-panel {
      width: 100%;
      overflow-y: visible;
    }
  }
</style>
