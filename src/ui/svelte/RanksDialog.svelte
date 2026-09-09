<script>
  import { appState } from '../../state.svelte.js';

  let visible = $derived(appState.ranksDialogVisible);

  function close() {
    appState.ranksDialogVisible = false;
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) close();
  }

  $effect(() => {
    function onKeydown(e) {
      if (e.key === 'Escape' && appState.ranksDialogVisible) close();
    }
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  });

  const roomRanks = [
    {
      name: 'Unregistered',
      color: 'var(--role-guest)',
      abilities: ['Draw and chat anonymously'],
    },
    {
      name: 'User',
      color: 'var(--role-user)',
      abilities: ['Upload images', 'Upload to gallery'],
    },
    {
      name: 'Trusted',
      color: 'var(--role-trusted)',
      abilities: ['Mute / unmute users'],
    },
    {
      name: 'Helper',
      color: 'var(--role-helper)',
      abilities: ["Kick and ban users"],
    },
    {
      name: 'Mod',
      color: 'var(--role-mod)',
      abilities: ['Clear canvas', 'Wipe user strokes', 'View mod list'],
    },
    {
      name: 'Admin',
      color: 'var(--role-admin)',
      abilities: ['All Mod abilities', 'Update room settings', 'Assign room roles'],
    },
    {
      name: 'Owner',
      color: '#e53935',
      abilities: ['All Admin abilities', 'Full room authority'],
    },
  ];

  const globalRanks = [
    {
      name: 'Noble',
      color: 'var(--role-noble)',
      abilities: ['Mute, kick, and wipe user strokes in all rooms', 'Can also receive room ranks', 'Join messages include their room rank'],
    },
    {
      name: 'Holy',
      color: 'var(--role-holy)',
      abilities: ['Owner-level room powers in all rooms', 'Ban users in all rooms'],
    },
    {
      name: 'Deity',
      color: 'var(--role-deity)',
      abilities: ['Unlimited power'],
    },
  ];
</script>

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="ranks-backdrop" onclick={handleBackdropClick} role="presentation">
    <div class="ranks-dialog" data-tut="ranks-dialog" role="dialog" aria-modal="true" aria-label="Ranks">
      <div class="ranks-header">
        <h2>Ranks</h2>
        <button class="close-btn" onclick={close} type="button" aria-label="Close">×</button>
      </div>

      <div class="ranks-body">
        <section>
          <h3 class="section-label">Room Ranks</h3>
          <ul class="ranks-grid">
            {#each roomRanks as rank}
              <li class="rank-card" style="--rank-color: {rank.color}">
                <span class="rank-name">{rank.name}</span>
                <ul class="rank-abilities">
                  {#each rank.abilities as ability}
                    <li>{ability}</li>
                  {/each}
                </ul>
              </li>
            {/each}
          </ul>
        </section>

        <section>
          <h3 class="section-label global">Global Ranks</h3>
          <ul class="ranks-grid global-grid">
            {#each globalRanks as rank}
              <li class="rank-card global-card" style="--rank-color: {rank.color}">
                <span class="rank-name">{rank.name}</span>
                <ul class="rank-abilities">
                  {#each rank.abilities as ability}
                    <li>{ability}</li>
                  {/each}
                </ul>
              </li>
            {/each}
          </ul>
        </section>
      </div>
    </div>
  </div>
{/if}

<style>
  .ranks-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 99900;
    backdrop-filter: blur(2px);
  }

  .ranks-dialog {
    width: min(900px, 96vw);
    max-height: 88vh;
    background: var(--bg-secondary, #1a1d26);
    border: 1px solid var(--border-color, rgba(255,255,255,0.08));
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
  }

  .ranks-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.9rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.07));
    flex-shrink: 0;
  }

  .ranks-header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary, #e8eaf0);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-secondary, #8a8fa8);
    font-size: 1.4rem;
    line-height: 1;
    cursor: pointer;
    padding: 0.15rem 0.4rem;
    border-radius: 6px;
    transition: background 0.15s, color 0.15s;
  }

  .close-btn:hover {
    background: rgba(255, 107, 107, 0.15);
    color: #ff6b6b;
  }

  .ranks-body {
    overflow-y: auto;
    padding: 1rem 1.25rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
  }

  .section-label {
    margin: 0 0 0.55rem;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-secondary, #6b7280);
  }

  .section-label.global {
    color: var(--role-noble, #ba95ff);
    opacity: 0.85;
  }

  .ranks-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 0.5rem;
  }

  .global-grid {
    grid-template-columns: repeat(3, 1fr);
  }

  .rank-card {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.7rem 0.75rem;
    border-radius: 9px;
    background: var(--bg-elevated, rgba(255,255,255,0.03));
    border: 1px solid color-mix(in srgb, var(--rank-color) 22%, transparent);
    transition: background 0.15s, border-color 0.15s;
  }

  .rank-card:hover {
    background: color-mix(in srgb, var(--rank-color) 6%, var(--bg-elevated, rgba(255,255,255,0.03)));
    border-color: color-mix(in srgb, var(--rank-color) 40%, transparent);
  }

  .rank-name {
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--rank-color);
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .global-card .rank-name {
    text-shadow: 0 0 10px color-mix(in srgb, var(--rank-color) 60%, transparent);
  }

  .rank-abilities {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .rank-abilities li {
    font-size: 0.72rem;
    color: var(--text-secondary, #8a8fa8);
    line-height: 1.4;
  }

  /* While the mobile tutorial toast is showing (see TutorialOverlay.svelte),
     shrink this dialog's own space so it renders below the toast instead of
     under it. */
  @media (max-width: 640px), (max-height: 640px) {
    :global(html[data-tutorial-active='true']) .ranks-backdrop {
      align-items: flex-start;
      padding-top: calc(var(--tutorial-toast-bottom, 0px) + 8px);
    }

    :global(html[data-tutorial-active='true']) .ranks-dialog {
      max-height: calc(88vh - var(--tutorial-toast-bottom, 0px) - 8px);
    }
  }
</style>
