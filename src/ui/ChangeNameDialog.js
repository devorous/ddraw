/**
 * "Change name" dialog opened from the self context menu (right-click your own
 * name). Guests can rename in place or jump to the sign-in form; signed-in users
 * can drop to a guest session under a new name.
 *
 * Reuses the auth setup modal styling (.authSetupModal) so it matches the
 * Discord username prompt.
 */

const MAX_NAME_LENGTH = 20; // server/validation.js MAX_NAME_LENGTH

let els = null;
let handlers = {};

function ensureDialog() {
  if (els) return els;

  const backdrop = document.createElement('div');
  backdrop.className = 'authModalBackdrop';
  backdrop.style.display = 'none';

  const modal = document.createElement('div');
  modal.className = 'authSetupModal';
  modal.id = 'changeNameModal';
  modal.style.display = 'none';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'changeNameTitle');
  modal.innerHTML = `
    <button type="button" class="authSetupClose" data-role="close" aria-label="Close">&times;</button>
    <h3 id="changeNameTitle">Change name</h3>
    <p class="authSetupText" data-role="text"></p>
    <input class="authInput" data-role="input" maxlength="${MAX_NAME_LENGTH}" autocomplete="off" placeholder="Pick a username">
    <p class="authResetMessage" data-role="message"></p>
    <div class="authSetupActions">
      <button type="button" class="btn primary large" data-role="guest"></button>
      <button type="button" class="btn secondary large" data-role="signin">Sign in</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(modal);

  els = {
    backdrop,
    modal,
    text: modal.querySelector('[data-role="text"]'),
    input: modal.querySelector('[data-role="input"]'),
    message: modal.querySelector('[data-role="message"]'),
    guestBtn: modal.querySelector('[data-role="guest"]'),
    signinBtn: modal.querySelector('[data-role="signin"]'),
    closeBtn: modal.querySelector('[data-role="close"]'),
  };

  const submit = () => {
    const name = els.input.value.trim();
    if (!name) {
      setMessage('Enter a name.');
      els.input.focus();
      return;
    }
    closeChangeNameDialog();
    handlers.onGuest?.(name);
  };

  els.guestBtn.addEventListener('click', submit);
  els.signinBtn.addEventListener('click', () => {
    closeChangeNameDialog();
    handlers.onSignIn?.();
  });
  els.closeBtn.addEventListener('click', closeChangeNameDialog);
  backdrop.addEventListener('click', closeChangeNameDialog);
  modal.addEventListener('keydown', (e) => {
    // Keep typing out of the board's hotkeys.
    e.stopPropagation();
    if (e.key === 'Enter' && e.target === els.input) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeChangeNameDialog();
    }
  });
  els.input.addEventListener('input', () => setMessage(''));

  return els;
}

function setMessage(text) {
  if (!els) return;
  els.message.textContent = text || '';
  els.message.dataset.kind = text ? 'error' : 'neutral';
}

/**
 * @param {Object} options
 * @param {string} options.currentName - Prefills the input.
 * @param {boolean} options.isLoggedIn - Signed-in users get "Continue as guest"
 *   instead of a rename, and no sign-in button.
 * @param {string} [options.accountName]
 * @param {(name: string) => void} options.onGuest
 * @param {() => void} options.onSignIn
 */
export function openChangeNameDialog({ currentName = '', isLoggedIn = false, accountName = '', onGuest, onSignIn }) {
  const d = ensureDialog();
  handlers = { onGuest, onSignIn };

  if (isLoggedIn) {
    d.text.textContent = `You're signed in as ${accountName || currentName}. Continue as a guest under a new name — this signs you out and rejoins the room.`;
    d.guestBtn.textContent = 'Continue as guest';
    d.signinBtn.style.display = 'none';
  } else {
    d.text.textContent = 'Pick a new guest name, or sign in to use your account.';
    d.guestBtn.textContent = 'Change name';
    d.signinBtn.style.display = '';
  }

  d.input.value = currentName;
  setMessage('');
  d.backdrop.style.display = 'block';
  d.modal.style.display = 'block';
  d.input.focus();
  d.input.select();
}

export function closeChangeNameDialog() {
  if (!els) return;
  els.backdrop.style.display = 'none';
  els.modal.style.display = 'none';
}
