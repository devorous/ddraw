/**
 * @fileoverview Shared "genie" open/close effect for small floating panels
 * (FloatingPalette, DockablePanel's board colour picker) - on hide, the panel
 * shrinks and fades toward the button that will reopen it; on show, it grows
 * back out from that same spot. Keeps minimize/restore legible instead of the
 * panel just popping in/out of existence.
 */

const DURATION_MS = 220;

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Points `panelEl`'s transform-origin at `targetEl`'s center via CSS vars. */
function setGenieOrigin(panelEl, targetEl) {
  const panelRect = panelEl.getBoundingClientRect();
  const targetRect = targetEl?.getBoundingClientRect?.();
  if (!panelRect.width || !panelRect.height || !targetRect) {
    panelEl.style.removeProperty('--genie-x');
    panelEl.style.removeProperty('--genie-y');
    return;
  }

  const originX = ((targetRect.left + targetRect.width / 2 - panelRect.left) / panelRect.width) * 100;
  const originY = ((targetRect.top + targetRect.height / 2 - panelRect.top) / panelRect.height) * 100;
  panelEl.style.setProperty('--genie-x', `${originX}%`);
  panelEl.style.setProperty('--genie-y', `${originY}%`);
}

function runOnce(panelEl, className, onDone) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    panelEl.classList.remove(className);
    panelEl.removeEventListener('animationend', finish);
    onDone?.();
  };

  panelEl.classList.remove(className);
  void panelEl.offsetWidth; // restart the animation if it's still mid-flight
  panelEl.classList.add(className);
  panelEl.addEventListener('animationend', finish, { once: true });
  // Belt-and-suspenders in case the animationend event never fires.
  setTimeout(finish, DURATION_MS + 80);
}

/** Shrinks `panelEl` toward `targetEl`, then calls `onHidden` once it's done. */
export function playGenieOut(panelEl, targetEl, onHidden) {
  if (!panelEl || prefersReducedMotion()) {
    onHidden?.();
    return;
  }

  setGenieOrigin(panelEl, targetEl);
  runOnce(panelEl, 'genie-out', onHidden);
}

/** Grows `panelEl` back out from `targetEl`. Call right after it becomes visible. */
export function playGenieIn(panelEl, targetEl) {
  if (!panelEl || prefersReducedMotion()) return;

  setGenieOrigin(panelEl, targetEl);
  runOnce(panelEl, 'genie-in', null);
}
