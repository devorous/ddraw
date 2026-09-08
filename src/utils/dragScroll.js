/**
 * @fileoverview Click/drag-to-scroll for mouse and pen pointers.
 *
 * Touch already scrolls scrollable elements natively via the browser's own
 * pan gesture. A stylus (pointerType 'pen') does not — pressing and dragging
 * with a tablet pen behaves like a mouse (selects text / does nothing), so
 * scrollable panels are otherwise unusable with a pen. This makes mouse/pen
 * drags behave like a touch pan on any element it's attached to.
 */

const IGNORE_SELECTOR = 'input, textarea, select, button, a[href], [role="slider"], [contenteditable], .no-drag-scroll';

// Movement (px) before a press is treated as a drag rather than a click —
// keeps ordinary clicks/taps inside the panel (buttons, dropdown rows, etc.)
// working normally.
const DRAG_THRESHOLD = 6;

/**
 * @param {HTMLElement} el - the scrollable element (overflow-y/x: auto|scroll)
 * @param {{ axis?: 'both'|'x'|'y' }} [options]
 * @returns {() => void} cleanup function
 */
export function enableDragScroll(el, options = {}) {
  if (!el) return () => {};
  const axis = options.axis || 'both';
  let drag = null;

  const onPointerDown = (e) => {
    if (e.pointerType === 'touch') return; // native touch panning already works
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest(IGNORE_SELECTOR)) return;

    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startScrollLeft: el.scrollLeft,
      startScrollTop: el.scrollTop,
      dragging: false,
    };
  };

  const onPointerMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      drag.dragging = true;
      el.setPointerCapture(drag.pointerId);
      el.classList.add('drag-scrolling');
    }

    if (axis !== 'y') el.scrollLeft = drag.startScrollLeft - dx;
    if (axis !== 'x') el.scrollTop = drag.startScrollTop - dy;
    e.preventDefault();
  };

  // A drag that ends with a real scroll shouldn't also fire the click it
  // releases on (e.g. dragging and lifting over a button underneath).
  const suppressNextClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.removeEventListener('click', suppressNextClick, true);
  };

  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    if (drag.dragging) {
      el.classList.remove('drag-scrolling');
      if (el.hasPointerCapture(drag.pointerId)) el.releasePointerCapture(drag.pointerId);
      el.addEventListener('click', suppressNextClick, true);
    }
    drag = null;
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  return () => {
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', endDrag);
    el.removeEventListener('pointercancel', endDrag);
    el.removeEventListener('click', suppressNextClick, true);
  };
}

/** Svelte action form: `<div use:dragScrollAction>` */
export function dragScrollAction(node, options) {
  const destroy = enableDragScroll(node, options);
  return { destroy };
}
