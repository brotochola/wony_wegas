// Drags that work the same with a mouse, a finger or a pen (pointer events).

let dragging = 0;

// While something is being dragged, a finger must not scroll the page or the timeline.
window.addEventListener('touchmove', (e) => {
  if (dragging) e.preventDefault();
}, { passive: false });

export const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';

// Fingers on the screen right now; a gesture with two of them (a pinch) is never a tap.
const fingers = new Set();
let lastMulti = 0;
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  fingers.add(e.pointerId);
  if (fingers.size > 1) lastMulti = performance.now();
}, true);
for (const type of ['pointerup', 'pointercancel']) {
  window.addEventListener(type, (e) => fingers.delete(e.pointerId), true);
}

// Follows one pointer until it lifts (or the browser cancels it).
export function follow(e, move, up) {
  const id = e.pointerId;
  dragging++;
  const onMove = (ev) => {
    if (ev.pointerId === id) move?.(ev);
  };
  const finish = (ev) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    dragging--;
    up?.(ev);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

// A finger on something that also scrolls: a tap, a long press, or a scroll the browser keeps.
// Moving more than `slop` pixels before the long press means scrolling, so nothing else happens.
export function tapOrHold(e, { onTap, onHold, delay = 380, slop = 10 }) {
  const id = e.pointerId;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const began = performance.now();
  const multi = () => lastMulti >= began || fingers.size > 1;
  let settled = false;
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
  const onMove = (ev) => {
    if (ev.pointerId !== id || Math.hypot(ev.clientX - x0, ev.clientY - y0) <= slop) return;
    settled = true;
    stop();
  };
  const onUp = (ev) => {
    if (ev.pointerId !== id) return;
    stop();
    if (!settled && !multi()) {
      settled = true;
      onTap?.(ev);
    }
  };
  const onCancel = (ev) => {
    if (ev.pointerId !== id) return;
    settled = true;
    stop();
  };
  const timer = setTimeout(() => {
    if (settled || multi()) { stop(); return; }
    settled = true;
    stop();
    navigator.vibrate?.(12);
    onHold?.();
  }, delay);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

// Two fingers on an element: calls onPinch(scale) relative to when the second finger landed.
export function bindPinch(el, onStart, onPinch) {
  let start = 0;
  let frame = 0;
  const gap = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      start = gap(e.touches);
      onStart?.();
    }
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !start) return;
    e.preventDefault();
    const scale = gap(e.touches) / start;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => onPinch(scale));
  }, { passive: false });
  el.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) start = 0;
  });
}
