<script>
  import { appState } from '../../state.svelte.js';

  /**
   * @type {{
   *   item: any, x: number, y: number, liked?: boolean, likesCount?: number,
   *   dragging?: boolean, jump?: boolean, slow?: boolean,
   *   loaded?: boolean, onNeedMeta?: (id: string) => void,
   *   onLike?: (item: any) => Promise<void>, onComment?: (id: string) => void,
   *   onAuthorClick?: (username: string) => void,
   *   canHide?: boolean, hideConfirm?: boolean, onHide?: (item: any) => void,
   *   onPointerDown?: (e: PointerEvent) => void, isClickSuppressed?: () => boolean
   * }}
   */
  let {
    item,
    x,
    y,
    liked = false,
    likesCount = 0,
    dragging = false,
    jump = false,
    slow = false,
    // False until the card's details (author, thumbnail, hearts) arrive; `item` is just { id } until then
    loaded = true,
    onNeedMeta = null,
    onLike = null,
    onComment = null,
    onAuthorClick = null,
    canHide = false,
    hideConfirm = false,
    onHide = null,
    onPointerDown = null,
    isClickSuppressed = null
  } = $props();
  let liking = $state(false);
  let cardElement = $state(null);
  let imageInView = $state(false);
  let imageSrc = $derived(item.thumbUrl || item.url || '');
  let showAuthorLink = $derived(!!item.hasProfile && !!item.author && !!onAuthorClick);
  let lastLikePointerActivationAt = 0;
  let lastImagePointerActivationAt = 0;
  let lastAuthorPointerActivationAt = 0;
  let lastHidePointerActivationAt = 0;
  const POINTER_CLICK_SUPPRESS_MS = 400;

  async function handleLike() {
    if (!onLike || liking) return;

    liking = true;
    try {
      await onLike(item);
    } finally {
      liking = false;
    }
  }

  function handleComment() {
    if (onComment) {
      onComment(item.id);
    }
  }

  function handleImageClick() {
    // A drag that ends over the image is not a click
    if (isClickSuppressed?.()) return;
    // Open gallery item modal
    appState.galleryItemDialog = {
      visible: true,
      itemId: item.id
    };
  }

  function handleLikePointerUp(e) {
    if (e.pointerType === 'mouse') return;
    lastLikePointerActivationAt = performance.now();
    e.preventDefault();
    handleLike();
  }

  function handleLikeClick(e) {
    if (performance.now() - lastLikePointerActivationAt < POINTER_CLICK_SUPPRESS_MS) {
      e.preventDefault();
      return;
    }
    handleLike();
  }

  function handleImagePointerUp(e) {
    if (e.pointerType === 'mouse') return;
    lastImagePointerActivationAt = performance.now();
    e.preventDefault();
    handleImageClick();
  }

  function handleImageClickEvent(e) {
    if (performance.now() - lastImagePointerActivationAt < POINTER_CLICK_SUPPRESS_MS) {
      e.preventDefault();
      return;
    }
    handleImageClick();
  }

  function handleAuthorClick() {
    if (isClickSuppressed?.()) return;
    onAuthorClick?.(item.author);
  }

  function handleAuthorPointerUp(e) {
    if (e.pointerType === 'mouse') return;
    lastAuthorPointerActivationAt = performance.now();
    e.preventDefault();
    handleAuthorClick();
  }

  function handleHide() {
    if (isClickSuppressed?.()) return;
    onHide?.(item);
  }

  function handleHidePointerUp(e) {
    if (e.pointerType === 'mouse') return;
    lastHidePointerActivationAt = performance.now();
    e.preventDefault();
    handleHide();
  }

  function handleHideClickEvent(e) {
    if (performance.now() - lastHidePointerActivationAt < POINTER_CLICK_SUPPRESS_MS) {
      e.preventDefault();
      return;
    }
    handleHide();
  }

  function handleAuthorClickEvent(e) {
    if (performance.now() - lastAuthorPointerActivationAt < POINTER_CLICK_SUPPRESS_MS) {
      e.preventDefault();
      return;
    }
    handleAuthorClick();
  }

  $effect(() => {
    if (typeof IntersectionObserver === 'undefined' || !cardElement) {
      imageInView = true;
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        imageInView = !!entry?.isIntersecting;
      },
      { root: null, rootMargin: '320px' }
    );

    observer.observe(cardElement);
    return () => observer.disconnect();
  });

  // Details load lazily, for cards near the screen
  $effect(() => {
    if (imageInView && !loaded) onNeedMeta?.(item.id);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={cardElement}
  class="floating-art"
  class:dragging
  class:jump
  class:slow
  style="transform: translate({x}px, {y}px);"
  onpointerdown={(e) => onPointerDown?.(e)}
>
  <div class="art-card">
    <button class="art-image" onclick={handleImageClickEvent} onpointerup={handleImagePointerUp} title={item.title || 'Untitled'}>
      {#if imageInView && imageSrc}
        <img src={imageSrc} alt={item.title || 'Art'} loading="lazy" decoding="async" draggable="false" />
      {/if}
    </button>

    <div class="art-footer">
      {#if loaded}
      <button
        class="art-action-btn like-btn"
        class:liked={liked}
        disabled={liking}
        onclick={handleLikeClick}
        onpointerup={handleLikePointerUp}
        title="Like"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 14L7.2 13.3C3.4 9.9 1 7.7 1 5C1 2.8 2.8 1 5 1C6.4 1 7.7 1.7 8 2.8C8.3 1.7 9.6 1 11 1C13.2 1 15 2.8 15 5C15 7.7 12.6 9.9 8.8 13.3L8 14Z"
            fill={liked ? 'currentColor' : 'none'}
            stroke="currentColor"
            stroke-width="1.5"
          />
        </svg>
        <span class="like-count">{likesCount}</span>
      </button>
      {#if showAuthorLink}
        <button
          class="art-author art-author-link"
          title={`View ${item.author}'s profile`}
          onclick={handleAuthorClickEvent}
          onpointerup={handleAuthorPointerUp}
        >{item.author}</button>
      {:else}
        <span class="art-author">{item.author}</span>
      {/if}
      {:else}
        <span class="art-skeleton" aria-hidden="true"></span>
      {/if}
      {#if canHide && onHide}
        <button
          class="art-action-btn hide-btn"
          class:confirm={hideConfirm}
          title={hideConfirm ? 'Tap again to hide it from this room\'s floating gallery' : 'Hide from the floating gallery (moderator)'}
          aria-label="Hide from the floating gallery"
          onclick={handleHideClickEvent}
          onpointerup={handleHidePointerUp}
        >
          {#if hideConfirm}
            Hide?
          {:else}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M1.5 8C1.5 8 4 3.5 8 3.5C12 3.5 14.5 8 14.5 8C14.5 8 12 12.5 8 12.5C4 12.5 1.5 8 1.5 8Z" stroke="currentColor" stroke-width="1.4" />
              <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.4" />
              <path d="M2.5 13.5L13.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          {/if}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .floating-art {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: auto;
    z-index: 4;
    contain: layout paint style;
    content-visibility: auto;
    contain-intrinsic-size: 180px 200px;
    /* Server positions arrive every 100 ms; ease between them */
    transition: transform 120ms linear;
    touch-action: none;
    user-select: none;
    -webkit-touch-callout: none;
    cursor: grab;
  }

  /* Swaps and the settle cleanup move a card further than a tick can: glide instead of snapping */
  .floating-art.jump {
    transition: transform 650ms cubic-bezier(0.45, 0, 0.2, 1);
  }

  /* Slow mode: positions arrive once a second, so glide the whole way; no shadows, pop-in or hover lift */
  .floating-art.slow {
    transition: transform 1000ms ease-out;
  }

  .floating-art.slow .art-card,
  .floating-art.slow .art-card:hover {
    transform: none;
    box-shadow: none;
    animation: none;
    transition: none;
    outline: 1px solid rgba(0, 0, 0, 0.35);
  }

  /* Stands in for the like button and author until the card's details load */
  .art-skeleton {
    flex: 1;
    height: 24px;
    border-radius: 4px;
    background: var(--color-bg-tertiary, #1a1a1a);
  }

  .floating-art.dragging {
    transition: none;
    z-index: 6;
    cursor: grabbing;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: scale(0.9);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .art-card {
    background: var(--color-bg-secondary, #222);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    width: 180px;
    transition: transform 0.2s, box-shadow 0.2s;
    animation: fadeIn 0.3s ease-out;
  }

  .art-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
  }

  .floating-art.dragging .art-card {
    transform: scale(1.04);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.55);
  }

  .art-image {
    width: 100%;
    height: 140px;
    padding: 0;
    margin: 0;
    border: none;
    background: var(--color-bg-tertiary, #1a1a1a);
    cursor: pointer;
    display: block;
  }

  .art-image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .art-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    background: var(--color-bg-secondary, #222);
  }

  .art-action-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: none;
    background: var(--color-bg-tertiary, #1a1a1a);
    color: var(--color-text-secondary, #aaa);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.2s, color 0.2s;
  }

  .art-action-btn:hover {
    background: var(--color-bg-hover, #333);
    color: var(--color-text-primary, #fff);
  }

  .art-action-btn:disabled {
    opacity: 0.7;
    cursor: wait;
  }

  .like-btn.liked {
    color: #ff6b6b;
  }

  .hide-btn {
    flex-shrink: 0;
    margin-left: auto;
    min-height: 24px;
    padding: 4px 6px;
  }

  .hide-btn:hover,
  .hide-btn.confirm {
    background: #b3261e;
    color: #fff;
  }

  .like-count {
    font-weight: 500;
  }

  .art-author {
    font-size: 11px;
    color: var(--color-text-secondary, #aaa);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .art-author-link {
    min-width: 0;
    padding: 4px 0;
    border: none;
    background: none;
    font-family: inherit;
    cursor: pointer;
  }

  .art-author-link:hover,
  .art-author-link:focus-visible {
    color: var(--color-text-primary, #fff);
    text-decoration: underline;
  }
</style>
