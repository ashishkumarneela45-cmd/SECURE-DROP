/**
 * cursor.js — Custom Cursor + Magnetic Buttons  [BUG-FIXED VERSION]
 *
 * BUG FIXES in this version:
 * ─────────────────────────────────────────────────────────────
 * FIX 1: pointer-events: none — cursor elements NEVER block clicks.
 *         Previously, a cursor element could intercept mouse events.
 *         Fixed by applying pointer-events: none in both CSS and JS.
 *
 * FIX 2: Fixed positioning — cursor uses `position: fixed` tied to
 *         viewport coordinates (e.clientX / e.clientY), so it never
 *         drifts during scroll. No scroll offset calculation needed.
 *
 * FIX 3: Correct RAF loop — the lerp ring update runs inside its own
 *         requestAnimationFrame loop (not on mousemove). This means
 *         the ring animates smoothly at 60fps regardless of mouse speed.
 *
 * FIX 4: Robust hover detection — uses a shared `.cht` (cursor-hover-target)
 *         class applied to ALL interactive elements via querySelectorAll,
 *         plus a MutationObserver that catches dynamically added elements.
 *         Event delegation on document catches all events via bubbling.
 *
 * FIX 5: Input cursor restoration — when hovering text inputs the custom
 *         cursor hides and `has-custom-cursor` is temporarily removed from
 *         body so the native I-beam shows. Restored on mouseout.
 *
 * FIX 6: Touch/coarse-pointer guard uses matchMedia `(pointer: coarse)`
 *         reliably, not screen width.
 */

/**
 * Interactive element selectors that should trigger the hover state.
 * We tag all of these with class `.cht` at init time, then use a single
 * class check in the event handler — much cheaper than closest() on every event.
 */
const INTERACTIVE_SELECTORS = [
  'a[href]',
  'button',
  '[role="button"]',
  '[role="tab"]',
  '.drop-zone',
  '.quick-btn',
  '.faq-question',
  '.pw-mode-btn label',
  '.trust-badge',
  'select',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '.nav-logo',
  '.btn-copy',
  '.btn-share',
  '.btn-ghost',
  '.btn-ghost-full',
  '.unlimited-label',
].join(', ');

/** Text input selectors — hide custom cursor, show native I-beam */
const TEXT_INPUT_SELECTORS = 'input[type="text"], input[type="password"], input[type="number"], textarea';

function initCursor() {

  // ── Guard: touch / coarse pointer ─────────────────────────────────────────
  // Use pointer media query — reliable across all touch devices.
  // Screen width alone is NOT sufficient (e.g. touch-enabled laptops).
  if (window.matchMedia('(pointer: coarse)').matches) return;
  // Also skip if reduced motion is preferred
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // ── Create cursor elements ─────────────────────────────────────────────────
  const dot  = document.createElement('div');
  const ring = document.createElement('div');
  dot.id  = 'cursor-dot';
  ring.id = 'cursor-ring';
  // FIX 1: pointer-events none — set in CSS too but belt-and-suspenders in JS
  dot.style.pointerEvents  = 'none';
  ring.style.pointerEvents = 'none';
  document.body.append(dot, ring);
  document.body.classList.add('has-custom-cursor');

  // ── State ─────────────────────────────────────────────────────────────────
  // FIX 2: Use clientX/clientY (viewport coordinates) for fixed positioning.
  // These values are always relative to the viewport regardless of scroll.
  let mouseX = -200, mouseY = -200;  // start offscreen
  let ringX  = -200, ringY  = -200;
  let isTextInput = false;

  // LERP factor — 0.12 = smooth but not too floaty
  const LERP = 0.12;

  // ── Mouse tracking ────────────────────────────────────────────────────────
  document.addEventListener('mousemove', (e) => {
    // FIX 2: clientX/clientY = viewport coords, works correctly with scroll
    mouseX = e.clientX;
    mouseY = e.clientY;

    // Dot is instant — update directly on mousemove
    // FIX 3: Dot uses direct style, ring uses RAF loop below
    if (!isTextInput) {
      dot.style.transform = `translate3d(${mouseX}px, ${mouseY}px, 0) translate(-50%, -50%)`;
    }
  }, { passive: true });

  // ── FIX 3: RAF loop for ring ──────────────────────────────────────────────
  // The ring lerp runs inside requestAnimationFrame so it animates at
  // exactly 60fps, completely independent of mouse event rate.
  // This prevents jitter and ensures smooth easing even during fast moves.
  function animateRing() {
    // Lerp: move ring 12% of remaining distance to mouse each frame
    ringX += (mouseX - ringX) * LERP;
    ringY += (mouseY - ringY) * LERP;

    if (!isTextInput) {
      ring.style.transform = `translate3d(${ringX}px, ${ringY}px, 0) translate(-50%, -50%)`;
    }

    requestAnimationFrame(animateRing);
  }
  requestAnimationFrame(animateRing);

  // ── FIX 4: Tag all interactive elements with `.cht` class ─────────────────
  // We apply the class once at init (and via MutationObserver for late DOM).
  // Then the hover handler just checks el.classList.contains('cht') —
  // much cheaper than running `closest(longSelectorString)` on every event.

  function tagInteractiveElements() {
    document.querySelectorAll(INTERACTIVE_SELECTORS).forEach(el => {
      el.classList.add('cht');
    });
  }

  tagInteractiveElements();

  // MutationObserver: re-tag when DOM changes (e.g. upload success card appears)
  const mo = new MutationObserver(() => tagInteractiveElements());
  mo.observe(document.body, { childList: true, subtree: true });

  // ── Hover state via event delegation ─────────────────────────────────────
  // Single listener on document, uses `.cht` class check via closest().
  // `.closest('.cht')` walks up the DOM tree — handles clicks on child elements
  // (e.g. clicking the SVG icon inside a button).

  document.addEventListener('mouseover', (e) => {
    const el = e.target;

    // FIX 5: Text inputs — hide custom cursor, restore native I-beam
    if (el.matches(TEXT_INPUT_SELECTORS)) {
      isTextInput = true;
      dot.classList.add('cursor-hidden');
      ring.classList.add('cursor-hidden');
      document.body.classList.remove('has-custom-cursor');
      return;
    }
    isTextInput = false;
    document.body.classList.add('has-custom-cursor');
    dot.classList.remove('cursor-hidden');
    ring.classList.remove('cursor-hidden');

    // Check if hovering over or inside an interactive element
    if (el.closest('.cht')) {
      dot.classList.add('cursor-hover');
      ring.classList.add('cursor-hover');
    }
  }, { passive: true });

  document.addEventListener('mouseout', (e) => {
    // Only remove hover state when leaving a .cht element entirely
    // (not when moving between its children)
    const el   = e.target;
    const dest = e.relatedTarget;

    // If we're moving INTO a child that's still inside a .cht, keep hover state
    if (dest && dest.closest('.cht')) return;

    if (el.closest('.cht')) {
      dot.classList.remove('cursor-hover');
      ring.classList.remove('cursor-hover');
    }

    // Restore cursor after leaving a text input
    if (el.matches(TEXT_INPUT_SELECTORS)) {
      isTextInput = false;
      dot.classList.remove('cursor-hidden');
      ring.classList.remove('cursor-hidden');
      document.body.classList.add('has-custom-cursor');
    }
  }, { passive: true });

  // ── Click feedback ────────────────────────────────────────────────────────
  document.addEventListener('mousedown', () => {
    ring.classList.add('cursor-click');
    dot.classList.add('cursor-click');
  });
  document.addEventListener('mouseup', () => {
    ring.classList.remove('cursor-click');
    dot.classList.remove('cursor-click');
  });

  // ── Window enter/leave ────────────────────────────────────────────────────
  document.addEventListener('mouseleave', () => {
    dot.style.opacity = '0';
    ring.style.opacity = '0';
  });
  document.addEventListener('mouseenter', () => {
    dot.style.opacity = '';
    ring.style.opacity = '';
  });

  // ── First touch: clean up custom cursor ──────────────────────────────────
  // Belt-and-suspenders alongside the media query check above
  window.addEventListener('touchstart', () => {
    dot.remove();
    ring.remove();
    document.body.classList.remove('has-custom-cursor');
    mo.disconnect();
  }, { once: true, passive: true });
}


// ══════════════════════════════════════════════════════════════════════════════
// MAGNETIC BUTTONS (unchanged — no bugs reported)
// ══════════════════════════════════════════════════════════════════════════════

function initMagneticButtons(selector = '.magnetic', strength = 0.3) {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  document.querySelectorAll(selector).forEach(el => {
    const xTo = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3.out' });
    const yTo = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3.out' });

    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      const dx   = e.clientX - (rect.left + rect.width  / 2);
      const dy   = e.clientY - (rect.top  + rect.height / 2);
      xTo(dx * strength);
      yTo(dy * strength);
    });

    el.addEventListener('mouseleave', () => {
      xTo(0);
      yTo(0);
    });
  });
}
