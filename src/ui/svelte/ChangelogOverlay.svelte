<script>
  import { onMount } from 'svelte';
  import { CHANGELOG } from '../../changelog/changelogData.js';

  const LAST_SEEN_KEY = 'changelog_last_seen_version';
  const DISABLED_KEY = 'changelog_disabled';

  let visible = $state(false);
  let expanded = $state({});

  function currentVersion() {
    return typeof window !== 'undefined' ? String(window.APP_VERSION || '') : '';
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
      // Storage can fail in private browsing; the popup just won't persist "seen" state.
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const bounds = el.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }

  // Mirrors TutorialOverlay's maybeStart: poll until the board is actually on
  // screen (i.e. the user has joined a room), rather than hooking every one of
  // App.js's several join/resync code paths individually.
  function maybeShow() {
    if (visible) return;
    // /embed and /demo are throwaway, no-login sessions — a "what's new" popup
    // has nothing to do with why someone landed there.
    if (document.documentElement.dataset.embed === 'true') return;
    if (storageGet(DISABLED_KEY) === '1') return;
    const version = currentVersion();
    if (!version) return;

    // Show on any mismatch, including a never-before-seen key (first run on
    // this profile/device) — that used to silently record a baseline and
    // skip the popup instead, which meant nobody actually saw it until their
    // SECOND visit after a version bump. "Don't show again" below is the
    // opt-out for people who don't want it popping up at all.
    const seen = storageGet(LAST_SEEN_KEY);
    if (seen === version) return;

    const landing = document.getElementById('landingPage');
    const board = document.getElementById('boardContainer');
    if (isVisible(board) && !isVisible(landing)) {
      visible = true;
      storageSet(LAST_SEEN_KEY, version);
    }
  }

  function close() {
    visible = false;
  }

  function dontShowAgain() {
    storageSet(DISABLED_KEY, '1');
    close();
  }

  function toggleMore(i) {
    expanded = { ...expanded, [i]: !expanded[i] };
  }

  function handleKeydown(event) {
    if (visible && event.key === 'Escape') close();
  }

  onMount(() => {
    const interval = setInterval(maybeShow, 1000);
    window.addEventListener('keydown', handleKeydown);
    maybeShow();

    return () => {
      clearInterval(interval);
      window.removeEventListener('keydown', handleKeydown);
    };
  });
</script>

{#if visible}
  <div class="changelogLayer" role="presentation">
    <div class="changelogBackdrop" onclick={close}></div>
    <div class="changelogModal" role="dialog" aria-modal="true" aria-labelledby="changelogTitle">
      <div class="changelogHead">
        <svg class="changelogBrush" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 20c0-3.5 1.8-6 5-7l8.5-8.5a2.1 2.1 0 0 1 3 3L12 16c-1 3.2-3.5 5-8 5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M9 13.2c1 .3 1.8 1.1 2.1 2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        <div class="changelogHeadText">
          <h2 id="changelogTitle">What's new in Top Draw</h2>
          <div class="changelogSub">You're now on {currentVersion()}; here's what changed.</div>
        </div>
        <button class="changelogClose" onclick={close} aria-label="Close changelog">×</button>
      </div>

      <div class="changelogBody">
        {#each CHANGELOG as rel, i (rel.v + i)}
          <section class="changelogRelease" class:current={rel.current}>
            <div class="changelogReleaseHead">
              <span class="changelogVtag">{rel.v}</span>
              <span class="changelogDate">{rel.date}</span>
              {#if rel.note}<span class="changelogNote">{rel.note}</span>{/if}
            </div>
            {#if rel.items?.length}
              <ul class="changelogItems">
                {#each rel.items as [type, text]}
                  <li class="changelogItem type-{type}"><span class="changelogDot"></span><span>{text}</span></li>
                {/each}
              </ul>
            {/if}
            {#if rel.more?.length}
              {#if expanded[i]}
                <ul class="changelogItems changelogMore">
                  {#each rel.more as [type, text]}
                    <li class="changelogItem type-{type}"><span class="changelogDot"></span><span>{text}</span></li>
                  {/each}
                </ul>
              {/if}
              <button class="changelogMoreBtn" aria-expanded={!!expanded[i]} onclick={() => toggleMore(i)}>
                <span>{expanded[i] ? 'Show less' : `Show ${rel.moreTotal} more`}</span>
                <svg class="changelogChevron" class:flipped={expanded[i]} viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            {/if}
          </section>
        {/each}
      </div>

      <div class="changelogLegend">
        <span><i class="changelogDot type-added"></i>Added</span>
        <span><i class="changelogDot type-improved"></i>Improved</span>
        <span><i class="changelogDot type-fixed"></i>Fixed</span>
        <span><i class="changelogDot type-removed"></i>Removed</span>
        <button class="changelogDontShow" onclick={dontShowAgain}>Don't show again</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .changelogLayer {
    position: fixed;
    inset: 0;
    z-index: 100000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
  }

  .changelogBackdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.56);
  }

  .changelogModal {
    position: relative;
    width: 100%;
    max-width: 560px;
    max-height: 82vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary, #242830);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    border-radius: var(--radius-lg, 16px);
    box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.4));
    color: var(--text-primary, #f0f2f5);
    font-family: inherit;
  }

  .changelogHead {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 22px 24px 16px;
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
  }

  .changelogBrush {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--accent-primary, #00d4aa);
  }

  .changelogHeadText {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .changelogHeadText h2 {
    margin: 0;
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .changelogSub {
    font-size: 12.5px;
    color: var(--text-secondary, #a0a8b8);
  }

  .changelogClose {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 8px;
    background: var(--bg-tertiary, #2d323c);
    color: var(--text-secondary, #a0a8b8);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    transition: background var(--transition-fast, 0.15s ease), color var(--transition-fast, 0.15s ease);
  }

  .changelogClose:hover {
    background: var(--accent-primary, #00d4aa);
    color: #06120f;
  }

  .changelogBody {
    overflow-y: auto;
    padding: 4px 24px 22px;
  }

  .changelogRelease {
    padding: 18px 0 2px;
    border-bottom: 1px dashed var(--border-subtle, rgba(255, 255, 255, 0.08));
  }

  .changelogRelease:last-child {
    border-bottom: none;
  }

  .changelogReleaseHead {
    display: flex;
    align-items: baseline;
    gap: 9px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .changelogVtag {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-weight: 500;
    font-size: 12.5px;
    background: var(--bg-tertiary, #2d323c);
    color: var(--text-primary, #f0f2f5);
    padding: 3px 8px;
    border-radius: 6px;
    letter-spacing: 0.01em;
  }

  .changelogRelease.current .changelogVtag {
    background: var(--accent-primary, #00d4aa);
    color: #06120f;
  }

  .changelogDate {
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    color: var(--text-muted, #6b7280);
  }

  .changelogNote {
    font-size: 11.5px;
    color: var(--text-muted, #6b7280);
    font-style: italic;
  }

  .changelogItems {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .changelogMore {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dotted var(--border-subtle, rgba(255, 255, 255, 0.08));
  }

  .changelogItem {
    display: flex;
    gap: 8px;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--text-primary, #f0f2f5);
  }

  .changelogDot {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    margin-top: 6px;
    border-radius: 50%;
  }

  .type-added .changelogDot,
  .changelogDot.type-added {
    background: #3ddc97;
  }

  .type-improved .changelogDot,
  .changelogDot.type-improved {
    background: var(--accent-primary, #00d4aa);
  }

  .type-fixed .changelogDot,
  .changelogDot.type-fixed {
    background: #ff9d54;
  }

  .type-removed .changelogDot,
  .changelogDot.type-removed {
    background: var(--text-muted, #8b93a3);
  }

  .changelogMoreBtn {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 9px;
    border: none;
    background: none;
    color: var(--text-secondary, #a0a8b8);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    padding: 2px 0;
  }

  .changelogMoreBtn:hover {
    color: var(--accent-primary, #00d4aa);
  }

  .changelogChevron {
    width: 10px;
    height: 10px;
    transition: transform 0.18s ease;
  }

  .changelogChevron.flipped {
    transform: rotate(180deg);
  }

  .changelogLegend {
    display: flex;
    gap: 13px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--text-muted, #6b7280);
    padding: 12px 24px 18px;
    border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
  }

  .changelogLegend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .changelogLegend .changelogDot {
    margin-top: 0;
  }

  .changelogDontShow {
    margin-left: auto;
    border: none;
    background: none;
    color: var(--text-muted, #6b7280);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    padding: 2px 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .changelogDontShow:hover {
    color: var(--text-secondary, #a0a8b8);
  }
</style>
