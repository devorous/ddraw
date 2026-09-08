<script>
  import { appState } from '../../state.svelte.js';
  import { BADGES, badgePickerOptions, effectiveBadgeId } from '../Badges.js';

  let { galleryBaseUrl = '/gallery', apiBaseUrl = '', onViewGallery = null, onImageClick = null } = $props();

  let savingBadge = $state(false);
  let badgeMenuOpen = $state(false);
  let badgePickerEl = $state(null);
  // For the user's own profile, fall back to the in-app self state for Discord
  // link status so the badge shows even if the profile fetch predates it.
  let badgeData = $derived((() => {
    const d = data || {};
    const selfHasDiscord = (typeof window !== 'undefined') ? window.app?.self?.hasDiscord : false;
    const selfIsSupporter = (typeof window !== 'undefined') ? window.app?.self?.isSupporter : false;
    return {
      ...d,
      hasDiscord: (d.hasDiscord ?? (d.isOwn ? selfHasDiscord : false)) || false,
      isSupporter: (d.isSupporter ?? (d.isOwn ? selfIsSupporter : false)) || false
    };
  })());
  let badgeOptions = $derived(badgePickerOptions(badgeData));
  let currentBadgeId = $derived(effectiveBadgeId(badgeData));

  let visible = $derived(appState.profileDialog.visible);
  let username = $derived(appState.profileDialog.username);
  let data = $derived(appState.profileDialog.data);
  let loading = $derived(appState.profileDialog.loading);
  let error = $derived(appState.profileDialog.error);
  let recentUploads = $derived(data?.recentUploads || []);

  const PX_PER_METER = 3779;
  const ROLE_NAMES = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble Mod', 'Holy Mod', 'Deity Mod'];
  const AVATAR_TARGET_PX = 256;
  const AVATAR_QUALITY = 0.82;

  let savingAvatar = $state(false);
  let editError = $state('');
  let fileInputEl = $state();
  let playingTimelapseId = $state(null);

  function toggleTimelapse(e, item) {
    e.stopPropagation();
    playingTimelapseId = playingTimelapseId === item.id ? null : item.id;
  }

  function rankClass(role) {
    if (role >= 9) return 'rank-deity';
    if (role >= 8) return 'rank-holy';
    if (role >= 7) return 'rank-noble';
    if (role >= 5) return 'rank-admin';
    if (role >= 4) return 'rank-mod';
    if (role >= 3) return 'rank-helper';
    if (role >= 2) return 'rank-trusted';
    if (role >= 1) return 'rank-user';
    return 'rank-guest';
  }

  function roleName(role) {
    return ROLE_NAMES[Math.max(0, Math.min(9, role | 0))] || 'User';
  }

  function avatarInitial(name) {
    if (!name) return '?';
    return [...name][0].toUpperCase();
  }

  function avatarHue(name) {
    if (!name) return 200;
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = (h * 31 + name.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  function formatMeters(px) {
    const m = (px || 0) / PX_PER_METER;
    if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
    if (m >= 1) return `${m.toFixed(1)} m`;
    return `${(m * 100).toFixed(0)} cm`;
  }

  function formatTime(ms) {
    const totalMin = Math.floor((ms || 0) / 60000);
    const days = Math.floor(totalMin / (60 * 24));
    const hours = Math.floor((totalMin % (60 * 24)) / 60);
    const mins = totalMin % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    parts.push(`${mins}m`);
    return parts.join(' ');
  }

  function formatNumber(n) {
    return (n || 0).toLocaleString();
  }

  function close() {
    appState.profileDialog = {
      visible: false,
      username: null,
      data: null,
      loading: false,
      error: null
    };
    editError = '';
    playingTimelapseId = null;
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) close();
  }

  function handleImageClick(item) {
    if (onImageClick) {
      close();
      onImageClick(item);
    } else {
      const base = String(galleryBaseUrl || '/gallery').replace(/\/$/, '');
      window.location.href = `${base}/${encodeURIComponent(item.id)}`;
    }
  }

  function getGalleryUrl(pathSegment) {
    const base = String(galleryBaseUrl || '/gallery').replace(/\/$/, '');
    return `${base}/${encodeURIComponent(pathSegment)}`;
  }

  function handleViewAll(e) {
    if (onViewGallery && data) {
      e.preventDefault();
      const username = data.username;
      close();
      onViewGallery(username);
    }
  }

  function formatJoinDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-CA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  function chooseAvatar() {
    fileInputEl?.click();
  }

  function handleChangeUsername() {
    const auth = typeof window !== 'undefined' ? window.app?.auth : null;
    if (!auth || typeof auth.showUsernameSetupModal !== 'function') return;
    close();
    auth.showUsernameSetupModal({ force: true });
  }

  async function handleAvatarFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      editError = 'Select an image file';
      return;
    }
    if (savingAvatar) return;
    savingAvatar = true;
    editError = '';
    try {
      const dataUrl = await resizeImageToDataUrl(file, AVATAR_TARGET_PX, AVATAR_QUALITY);
      const updated = await patchProfile({ avatar: dataUrl });
      appState.profileDialog = {
        ...appState.profileDialog,
        data: { ...data, avatar: updated.avatar ?? dataUrl }
      };
    } catch (err) {
      editError = err?.message || 'Failed to upload avatar';
    } finally {
      savingAvatar = false;
    }
  }

  async function applyBadge(badgeId) {
    badgeMenuOpen = false;
    if (savingBadge) return;
    savingBadge = true;
    editError = '';
    try {
      const updated = await patchProfile({ selectedBadge: badgeId });
      const applied = updated.selectedBadge ?? badgeId;
      appState.profileDialog = {
        ...appState.profileDialog,
        data: { ...data, selectedBadge: applied }
      };
      if (typeof window !== 'undefined') window.app?.applySelfBadge?.(applied);
    } catch (err) {
      editError = err?.message || 'Failed to save badge';
    } finally {
      savingBadge = false;
    }
  }

  $effect(() => {
    if (!badgeMenuOpen) return;
    function onDocPointer(e) {
      if (badgePickerEl && !badgePickerEl.contains(e.target)) badgeMenuOpen = false;
    }
    document.addEventListener('mousedown', onDocPointer);
    return () => document.removeEventListener('mousedown', onDocPointer);
  });

  async function removeAvatar() {
    if (savingAvatar) return;
    savingAvatar = true;
    editError = '';
    try {
      await patchProfile({ avatar: null });
      appState.profileDialog = {
        ...appState.profileDialog,
        data: { ...data, avatar: null }
      };
    } catch (err) {
      editError = err?.message || 'Failed to remove avatar';
    } finally {
      savingAvatar = false;
    }
  }

  async function patchProfile(body) {
    const token = localStorage.getItem('topDrawAuthToken');
    if (!token) throw new Error('Not signed in');
    const res = await fetch(`${apiBaseUrl}/api/users/me/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Save failed');
    return json;
  }

  function resizeImageToDataUrl(file, maxSize, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = maxSize;
        canvas.height = maxSize;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load image'));
      };
      img.src = url;
    });
  }

  $effect(() => {
    function handleKeydown(e) {
      if (e.key === 'Escape' && appState.profileDialog.visible) {
        close();
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });
</script>

{#snippet badgeIcon(id)}
  {#if BADGES[id]?.img}
    <img class="profile-badge-img" src={BADGES[id].img} alt={BADGES[id].label} draggable="false">
  {:else if BADGES[id]?.svg}
    <span class="profile-badge-svg" style="color: {BADGES[id].color || 'currentColor'}">{@html BADGES[id].svg}</span>
  {/if}
{/snippet}

{#if visible}
  <div
    class="profile-dialog-backdrop"
    onclick={handleBackdropClick}
    role="presentation"
  >
    <div
      class="profile-dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <button class="profile-dialog-close" onclick={close} title="Close">&times;</button>

      <div class="profile-dialog-body">
        {#if loading}
          <div class="profile-dialog-loading">Loading...</div>
        {:else if error}
          <div class="profile-dialog-error">{error}</div>
        {:else if data}
          {@const role = data.role || 1}
          {@const rcls = rankClass(role)}
          {@const isOwn = !!data.isOwn}

          <div class="profile-header">
            <div class="profile-avatar-wrap">
              <div
                class="profile-avatar {rcls}"
                style="--avatar-hue: {avatarHue(data.username)};"
              >
                {#if data.avatar}
                  <img class="profile-avatar-img" src={data.avatar} alt="avatar">
                {:else}
                  <span class="profile-avatar-initial">{avatarInitial(data.username)}</span>
                {/if}
              </div>
              {#if isOwn}
                <button
                  class="profile-avatar-edit"
                  onclick={chooseAvatar}
                  disabled={savingAvatar}
                  title="Change avatar"
                  aria-label="Change avatar"
                >
                  {#if savingAvatar}…{:else}✎{/if}
                </button>
                <input
                  bind:this={fileInputEl}
                  type="file"
                  accept="image/*"
                  style="display:none"
                  onchange={handleAvatarFile}
                >
              {/if}
            </div>

            <div class="profile-identity">
              <div class="profile-username-row">
                <h2 class="profile-username {rcls}">{data.username}</h2>
                {#if isOwn}
                  <span class="profile-badge-picker" bind:this={badgePickerEl}>
                    <button
                      type="button"
                      class="profile-badge-trigger"
                      onclick={() => { if (!savingBadge) badgeMenuOpen = !badgeMenuOpen; }}
                      disabled={savingBadge}
                      aria-haspopup="listbox"
                      aria-expanded={badgeMenuOpen}
                      title="Choose your badge"
                    >
                      {#if currentBadgeId && BADGES[currentBadgeId]}
                        {@render badgeIcon(currentBadgeId)}
                      {:else}
                        <span class="profile-badge-noicon"></span>
                      {/if}
                      <span class="profile-badge-caret">▾</span>
                    </button>
                    {#if badgeMenuOpen}
                      <div class="profile-badge-menu" role="listbox">
                        <button
                          type="button"
                          class="profile-badge-option"
                          class:selected={!currentBadgeId}
                          onclick={() => applyBadge('none')}
                          title="No badge"
                          role="option"
                          aria-selected={!currentBadgeId}
                        >
                          <span class="profile-badge-noicon"></span>
                        </button>
                        {#each badgeOptions as opt}
                          <button
                            type="button"
                            class="profile-badge-option"
                            class:selected={opt.id === currentBadgeId}
                            onclick={() => applyBadge(opt.id)}
                            title={opt.label}
                            role="option"
                            aria-selected={opt.id === currentBadgeId}
                          >
                            {@render badgeIcon(opt.id)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </span>
                {:else if currentBadgeId && BADGES[currentBadgeId]}
                  <span class="profile-badge-current" title={BADGES[currentBadgeId].label}>
                    {@render badgeIcon(currentBadgeId)}
                  </span>
                {/if}
              </div>
              <div class="profile-role-row">
                <span class="profile-role-badge {rcls}">{roleName(role)}</span>
                {#if data.createdAt}
                  <span class="profile-meta">Joined {formatJoinDate(data.createdAt)}</span>
                {/if}
              </div>
              {#if isOwn && data.avatar}
                <button class="profile-avatar-remove" onclick={removeAvatar} disabled={savingAvatar}>
                  Remove avatar
                </button>
              {/if}
            </div>
          </div>

          {#if editError}
            <div class="profile-edit-error">{editError}</div>
          {/if}

          <div class="profile-stats-grid">
                <div class="profile-stat">
                  <div class="profile-stat-value">{formatMeters(data.distanceDrawn)}</div>
                  <div class="profile-stat-label">Distance Drawn</div>
                </div>
                <div class="profile-stat">
                  <div class="profile-stat-value">{formatTime(data.timeSpentMs)}</div>
                  <div class="profile-stat-label">Time Drawing</div>
                </div>
                <div class="profile-stat">
                  <div class="profile-stat-value">{formatNumber(data.totalStrokes)}</div>
                  <div class="profile-stat-label">Strokes</div>
                </div>
                <div class="profile-stat">
                  <div class="profile-stat-value">{formatNumber(data.uploadCount)}</div>
                  <div class="profile-stat-label">Uploads</div>
                </div>
                <div class="profile-stat">
                  <div class="profile-stat-value">{formatNumber(data.totalLikes)}</div>
                  <div class="profile-stat-label">Likes</div>
                </div>
                {#if data.consecutiveDaysDrawn > 0}
                  <div class="profile-stat">
                    <div class="profile-stat-value">{formatNumber(data.consecutiveDaysDrawn)}</div>
                    <div class="profile-stat-label">Day Streak</div>
                  </div>
                {/if}
              </div>

              <div class="profile-recent">
                <div class="profile-recent-title">Recent Uploads</div>
                <div class="profile-recent-grid">
                  {#if recentUploads.length > 0}
                    {#each recentUploads as item}
                      <div
                        class="profile-recent-item"
                        onclick={() => handleImageClick(item)}
                        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleImageClick(item); } }}
                        role="button"
                        tabindex="0"
                        title={item.title || 'View'}
                      >
                        {#if item.animatedUrl && playingTimelapseId === item.id}
                          <video
                            class="profile-recent-timelapse"
                            src={item.animatedUrl}
                            autoplay
                            muted
                            loop
                            playsinline
                            onclick={(e) => e.stopPropagation()}
                          ></video>
                        {:else}
                          <img src={item.thumbUrl} alt={item.title || 'artwork'} loading="lazy">
                        {/if}
                        {#if item.animatedUrl}
                          <button
                            type="button"
                            class="profile-recent-lapse-btn"
                            onclick={(e) => toggleTimelapse(e, item)}
                            title={playingTimelapseId === item.id ? 'Stop timelapse' : 'Play timelapse'}
                            aria-label={playingTimelapseId === item.id ? 'Stop timelapse' : 'Play timelapse'}
                          >
                            {playingTimelapseId === item.id ? '■' : '▶'}
                          </button>
                        {/if}
                      </div>
                    {/each}
                  {:else}
                    <div class="profile-recent-empty">No uploads yet</div>
                  {/if}
                </div>
              </div>

          <div class="profile-actions">
            <a
              href={getGalleryUrl(data.username)}
              class="profile-btn profile-btn-primary"
              target="_blank"
              onclick={handleViewAll}
            >
              View All Art
            </a>
            {#if isOwn}
              <button
                type="button"
                class="profile-btn"
                onclick={handleChangeUsername}
              >
                Change Username
              </button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .profile-dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 100010;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    backdrop-filter: blur(4px);
    animation: profileFadeIn 0.15s ease;
  }

  @keyframes profileFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .profile-dialog {
    position: relative;
    background: linear-gradient(180deg, #1c1c1f 0%, #141416 100%);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    max-width: 440px;
    width: 100%;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: profileSlideUp 0.2s ease;
    font-family: 'Inter', -apple-system, sans-serif;
    color: #e8e2d5;
    box-shadow: 0 24px 60px rgba(0,0,0,0.5);
  }

  @keyframes profileSlideUp {
    from { transform: translateY(16px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .profile-dialog-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    z-index: 2;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(0,0,0,0.4);
    border: 1px solid rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.6);
    font-size: 1.5rem;
    cursor: pointer;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background 0.15s, color 0.15s;
  }
  .profile-dialog-close:hover {
    background: rgba(255,255,255,0.1);
    color: #fff;
  }

  .profile-dialog-body {
    padding: 1.5rem;
    overflow-y: auto;
  }

  .profile-dialog-loading,
  .profile-dialog-error {
    text-align: center;
    padding: 2rem;
    color: rgba(255,255,255,0.5);
  }
  .profile-dialog-error { color: #e07070; }

  /* Header */
  .profile-header {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .profile-avatar-wrap {
    position: relative;
    flex-shrink: 0;
  }

  .profile-avatar {
    width: 72px;
    height: 72px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      linear-gradient(135deg,
        hsl(var(--avatar-hue, 200), 65%, 48%) 0%,
        hsl(calc(var(--avatar-hue, 200) + 35), 70%, 35%) 100%);
    border: 1px solid rgba(255,255,255,0.1);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    overflow: hidden;
  }
  .profile-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .profile-avatar-initial {
    font-size: 2.2rem;
    font-weight: 600;
    color: #fff;
    text-shadow: 0 2px 4px rgba(0,0,0,0.4);
    line-height: 1;
  }
  .profile-avatar.rank-noble {
    border-color: var(--role-noble);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3),
                0 0 16px color-mix(in srgb, var(--role-noble), transparent 60%);
  }
  .profile-avatar.rank-holy {
    border-color: var(--role-holy);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3),
                0 0 20px color-mix(in srgb, var(--role-holy), transparent 50%);
  }
  .profile-avatar.rank-deity {
    border-color: var(--role-deity);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3),
                0 0 24px color-mix(in srgb, var(--role-deity), transparent 35%);
  }

  .profile-avatar-edit {
    position: absolute;
    bottom: -4px;
    right: -4px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #0c0c0e;
    border: 1px solid rgba(255,255,255,0.2);
    color: #fff;
    font-size: 0.85rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
    box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    transition: background 0.15s, transform 0.15s;
  }
  .profile-avatar-edit:hover:not(:disabled) {
    background: #1f1f24;
    transform: scale(1.08);
  }
  .profile-avatar-edit:disabled { opacity: 0.5; cursor: wait; }

  .profile-identity { min-width: 0; flex: 1; }

  .profile-username {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0;
    letter-spacing: -0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #fff;
  }
  .profile-username.rank-noble {
    color: var(--role-noble);
    text-shadow: 0 0 8px color-mix(in srgb, var(--role-noble), transparent 60%);
  }
  .profile-username.rank-holy {
    color: var(--role-holy);
    text-shadow: 0 0 10px color-mix(in srgb, var(--role-holy), transparent 50%);
  }
  .profile-username.rank-deity {
    color: var(--role-deity);
    text-shadow: 0 0 12px color-mix(in srgb, var(--role-deity), transparent 35%);
    animation: deityShimmer 4s ease-in-out infinite;
  }

  @keyframes deityShimmer {
    0%, 100% { text-shadow: 0 0 10px color-mix(in srgb, var(--role-deity), transparent 40%); }
    50%      { text-shadow: 0 0 18px color-mix(in srgb, var(--role-deity), transparent 20%); }
  }

  .profile-role-row {
    margin-top: 0.4rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .profile-role-badge {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(255,255,255,0.06);
    color: rgba(255,255,255,0.7);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .profile-role-badge.rank-noble {
    color: var(--role-noble);
    background: color-mix(in srgb, var(--role-noble), transparent 85%);
    border-color: color-mix(in srgb, var(--role-noble), transparent 60%);
  }
  .profile-role-badge.rank-holy {
    color: var(--role-holy);
    background: color-mix(in srgb, var(--role-holy), transparent 85%);
    border-color: color-mix(in srgb, var(--role-holy), transparent 60%);
  }
  .profile-role-badge.rank-deity {
    color: var(--role-deity);
    background: color-mix(in srgb, var(--role-deity), transparent 80%);
    border-color: color-mix(in srgb, var(--role-deity), transparent 50%);
  }

  .profile-meta {
    font-size: 0.78rem;
    color: rgba(255,255,255,0.4);
  }

  /* Stats */
  .profile-stats-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
    margin-top: 1.25rem;
  }
  .profile-stat {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 8px;
    padding: 0.75rem 0.5rem;
    text-align: center;
    transition: background 0.15s, border-color 0.15s;
  }
  .profile-stat:hover {
    background: rgba(255,255,255,0.06);
    border-color: rgba(255,255,255,0.1);
  }
  .profile-stat-value {
    font-size: 1rem;
    font-weight: 600;
    color: #fff;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }
  .profile-stat-label {
    font-size: 0.65rem;
    color: rgba(255,255,255,0.45);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 0.35rem;
  }

  .profile-recent { margin-top: 1.5rem; }
  .profile-recent-title {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.4);
    margin-bottom: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .profile-recent-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }
  .profile-recent-item {
    position: relative;
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: 6px;
    background: #121212;
    border: 1px solid rgba(255,255,255,0.04);
    padding: 0;
    cursor: pointer;
  }
  .profile-recent-item img,
  .profile-recent-item video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.2s;
  }
  .profile-recent-item:hover img { transform: scale(1.05); }

  .profile-recent-lapse-btn {
    position: absolute;
    bottom: 4px;
    right: 4px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgba(0,0,0,0.6);
    border: 1px solid rgba(255,255,255,0.25);
    color: #fff;
    font-size: 0.6rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
  }
  .profile-recent-lapse-btn:hover {
    background: #00d4aa;
    color: #121212;
    transform: scale(1.08);
  }
  .profile-recent-empty {
    grid-column: 1 / -1;
    text-align: center;
    padding: 1rem;
    color: rgba(255,255,255,0.3);
    font-size: 0.82rem;
  }

  .profile-actions {
    margin-top: 1.25rem;
    display: flex;
    gap: 0.75rem;
  }
  .profile-btn {
    flex: 1;
    padding: 0.7rem 1rem;
    border: 1px solid rgba(255,255,255,0.08);
    background: none;
    color: rgba(255,255,255,0.6);
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.2s, color 0.2s, background 0.2s;
    text-decoration: none;
    text-align: center;
    display: block;
  }
  .profile-btn:hover {
    border-color: rgba(255,255,255,0.2);
    color: #fff;
  }
  .profile-btn-primary {
    background: #00d4aa;
    border-color: #00d4aa;
    color: #121212;
  }
  .profile-btn-primary:hover {
    background: #00f0c3;
    border-color: #00f0c3;
    color: #121212;
  }

  .profile-avatar-remove {
    margin-top: 0.4rem;
    background: none;
    border: none;
    color: rgba(224,112,112,0.85);
    font-size: 0.72rem;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
    text-decoration-color: rgba(224,112,112,0.3);
  }
  .profile-avatar-remove:hover { color: #ff8585; }
  .profile-avatar-remove:disabled { opacity: 0.5; cursor: wait; }

  .profile-edit-error {
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: #e07070;
    text-align: center;
  }

  .profile-username-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .profile-username-row .profile-username { min-width: 0; }

  /* Badge icon (img or coloured svg) */
  .profile-badge-img,
  .profile-badge-svg {
    width: 20px;
    height: 20px;
    display: block;
    flex: 0 0 20px;
  }
  .profile-badge-svg :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  /* Read-only badge next to another user's name */
  .profile-badge-current {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* "No icon" — a short horizontal line */
  .profile-badge-noicon {
    width: 14px;
    height: 2px;
    border-radius: 1px;
    background: rgba(255,255,255,0.55);
    display: block;
  }

  .profile-badge-picker { position: relative; flex: 0 0 auto; }

  .profile-badge-trigger {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px 5px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.04);
    color: #fff;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .profile-badge-trigger:hover:not(:disabled) {
    border-color: rgba(255,255,255,0.25);
    background: rgba(255,255,255,0.07);
  }
  .profile-badge-trigger:disabled { opacity: 0.5; cursor: wait; }
  .profile-badge-caret {
    font-size: 0.6rem;
    color: rgba(255,255,255,0.5);
    line-height: 1;
  }

  .profile-badge-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 5;
    display: flex;
    gap: 2px;
    padding: 4px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.12);
    background: #1c1c1f;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  .profile-badge-option {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 6px;
    border: 1px solid transparent;
    background: none;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .profile-badge-option:hover { background: rgba(255,255,255,0.08); }
  .profile-badge-option.selected {
    border-color: #00d4aa;
    background: rgba(0,212,170,0.12);
  }
</style>
