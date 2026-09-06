/**
 * preloader.js — Preloader + Hero Text-Split + Ambient Background
 *
 * STAGE 3 of the premium motion system.
 *
 * WHAT THIS FILE DOES:
 * ─────────────────────────────────────────────────────────────
 * 1. Preloader
 *    Black screen with the SecureDrop wordmark + a thin yellow bar
 *    that fills to 100% over ~1 second, then slides upward to reveal
 *    the page. Feels intentional, not like a spinner.
 *
 * 2. Hero text-split animation
 *    The headline "Share files. Vanish." is split word-by-word and each
 *    word animates in with a staggered reveal (slide up from below a clip-mask).
 *    This is the signature move of award-winning sites like Awwwards winners.
 *
 * 3. Particle field (ambient background)
 *    A canvas covering the hero section draws small dots that drift slowly.
 *    When the cursor moves nearby, dots are gently repelled (react to mouse).
 *    Very subtle opacity — adds life without distracting from the content.
 *    Lazy-initialized only when the hero is in view.
 *
 * 4. Film grain overlay
 *    A <canvas> generates animated noise texture tiled across the page.
 *    Rendered at very low opacity (0.035) — you barely see it consciously
 *    but it makes flat black feel rich and tactile.
 */

// ══════════════════════════════════════════════════════════════════════════════
// 1. PRELOADER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * runPreloader(onComplete)
 *
 * Runs the preloader animation. Calls onComplete() when done so the
 * page bootstrap (initAnimations, etc.) can start.
 *
 * @param {Function} onComplete - called after preloader exits
 */
function runPreloader(onComplete) {

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Build preloader DOM
  const overlay = document.createElement('div');
  overlay.id = 'preloader';
  overlay.innerHTML = `
    <div class="pl-inner">
      <div class="pl-logo">
        <svg class="pl-shield" viewBox="0 0 32 32" fill="none">
          <path d="M16 2L4 8v8c0 7 5.25 13.5 12 15 6.75-1.5 12-8 12-15V8L16 2z"
                fill="url(#plGrad)" opacity="0.9"/>
          <path d="M11 16l3.5 3.5L21 13" stroke="#000" stroke-width="2.2"
                stroke-linecap="round" stroke-linejoin="round"/>
          <defs>
            <linearGradient id="plGrad" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#FFD60A"/>
              <stop offset="100%" stop-color="#E6C009"/>
            </linearGradient>
          </defs>
        </svg>
        <span class="pl-wordmark">SecureDrop</span>
      </div>
      <div class="pl-bar-track">
        <div class="pl-bar" id="pl-bar"></div>
      </div>
      <div class="pl-pct" id="pl-pct">0%</div>
    </div>
  `;
  document.body.prepend(overlay);

  // Skip animation if reduced motion is preferred — just hide immediately
  if (prefersReduced) {
    overlay.style.display = 'none';
    onComplete();
    return;
  }

  const bar  = document.getElementById('pl-bar');
  const pct  = document.getElementById('pl-pct');

  // Animate bar from 0% to 100% over 900ms, then exit
  gsap.timeline({
    onComplete: () => exitPreloader(overlay, onComplete),
  })
  .to(bar, {
    scaleX: 1,
    duration: 0.9,
    ease: 'power2.inOut',
    onUpdate: function() {
      // Update percentage display during tween
      const progress = Math.round(this.progress() * 100);
      if (pct) pct.textContent = progress + '%';
    },
  })
  .to([bar, pct], { opacity: 0, duration: 0.15, ease: 'power1.in' }, '+=0.1');
}

/**
 * Slides the preloader overlay upward to reveal the page beneath.
 */
function exitPreloader(overlay, onComplete) {
  gsap.to(overlay, {
    yPercent: -100,
    duration: 0.75,
    ease: 'power3.inOut',
    onComplete: () => {
      overlay.remove();
      onComplete();
    },
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// 2. HERO TEXT-SPLIT ANIMATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * initHeroTextSplit()
 *
 * Splits the hero headline into individual words (wrapped in <span>s)
 * and animates each word up from below a clip mask.
 *
 * The visual effect: each word "rises" from below an invisible line,
 * appearing letter by letter. This is the "text reveal" technique used
 * by agencies like Fantasy, Resn, and many Awwwards winners.
 *
 * HOW IT WORKS:
 *   Each word gets wrapped in a .word-wrap (overflow: hidden) and a
 *   .word-inner span that starts translated 100% below and animates up.
 *   The overflow: hidden on the wrapper clips the word until it rises
 *   into view, creating the "reveal from below" effect.
 */
function initHeroTextSplit() {

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const titleEl = document.querySelector('.hero-title');
  if (!titleEl || prefersReduced) return;

  // Split text into word spans while preserving the .hero-gradient class
  // on the word "Vanish." (or whatever word has that class)
  const html = titleEl.innerHTML;

  // Replace text nodes word-by-word, preserving span tags like .hero-gradient
  // We parse the innerHTML and wrap text-only words in clip wrappers
  const fragment = document.createElement('div');
  fragment.innerHTML = html;

  function wrapWords(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const words = node.textContent.split(/(\s+)/);
      const frag  = document.createDocumentFragment();
      words.forEach(word => {
        if (/^\s+$/.test(word)) {
          // Preserve whitespace/line breaks as-is
          frag.appendChild(document.createTextNode(word));
        } else if (word) {
          const wrapper = document.createElement('span');
          wrapper.className = 'word-wrap';
          wrapper.setAttribute('aria-hidden', 'true'); // screen reader reads the original
          const inner = document.createElement('span');
          inner.className = 'word-inner';
          inner.textContent = word;
          wrapper.appendChild(inner);
          frag.appendChild(wrapper);
        }
      });
      node.parentNode.replaceChild(frag, node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Preserve spans (like .hero-gradient) but wrap their text content too
      Array.from(node.childNodes).forEach(child => wrapWords(child));
    }
  }

  Array.from(fragment.childNodes).forEach(child => wrapWords(child));

  // Add a visually-hidden copy for screen readers (so the split doesn't affect a11y)
  const srCopy = document.createElement('span');
  srCopy.className = 'sr-only';
  srCopy.textContent = titleEl.textContent;
  titleEl.setAttribute('aria-hidden', 'true');
  titleEl.parentElement.insertBefore(srCopy, titleEl);

  titleEl.innerHTML = fragment.innerHTML;

  // Animate each .word-inner upward into view with stagger
  const wordInners = titleEl.querySelectorAll('.word-inner');
  gsap.from(wordInners, {
    y: '105%',         // starts fully below the clip boundary
    opacity: 0,
    duration: 0.85,
    ease: 'power4.out',
    stagger: 0.07,     // 70ms between each word
    delay: 0.1,        // slight delay after preloader exits
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// 3. PARTICLE FIELD
// ══════════════════════════════════════════════════════════════════════════════

/**
 * initParticles()
 *
 * Draws a subtle ambient particle field on a canvas behind the hero content.
 * Dots drift slowly. When the mouse moves nearby, they gently repel.
 *
 * Performance notes:
 * - Uses requestAnimationFrame, not setInterval
 * - Canvas cleared and redrawn each frame (standard 2D canvas approach)
 * - Max 60 particles — invisible cost on modern hardware
 * - Canvas uses CSS `will-change: transform` hint (set in CSS)
 * - Lazy: only starts when the hero section is in the viewport
 */
function initParticles() {

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) return;

  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let W, H, particles;
  let mouseX = -9999, mouseY = -9999;
  let rafId = null;
  let running = false;

  // ── Resize handler — keeps canvas pixel-perfect ───────────────────────────
  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = canvas.width  = rect.width  * window.devicePixelRatio;
    H = canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    // Re-create particles when canvas resizes
    buildParticles();
  }

  // ── Particle factory ──────────────────────────────────────────────────────
  function buildParticles() {
    const cW = W / window.devicePixelRatio;
    const cH = H / window.devicePixelRatio;
    particles = Array.from({ length: 55 }, () => ({
      x:   Math.random() * cW,
      y:   Math.random() * cH,
      vx:  (Math.random() - 0.5) * 0.3,  // very slow drift
      vy:  (Math.random() - 0.5) * 0.3,
      r:   Math.random() * 1.5 + 0.5,    // 0.5–2px radius
      opacity: Math.random() * 0.3 + 0.05,
    }));
  }

  // ── Draw loop ─────────────────────────────────────────────────────────────
  function draw() {
    const cW = W / window.devicePixelRatio;
    const cH = H / window.devicePixelRatio;
    ctx.clearRect(0, 0, cW, cH);

    particles.forEach(p => {
      // Drift
      p.x += p.vx;
      p.y += p.vy;

      // Wrap around edges
      if (p.x < 0) p.x = cW;
      if (p.x > cW) p.x = 0;
      if (p.y < 0) p.y = cH;
      if (p.y > cH) p.y = 0;

      // Mouse repulsion — particles within 80px gently move away
      const dx   = p.x - mouseX;
      const dy   = p.y - mouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 80) {
        const force = (80 - dist) / 80;
        p.x += (dx / dist) * force * 1.5;
        p.y += (dy / dist) * force * 1.5;
      }

      // Draw dot
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 214, 10, ${p.opacity})`;  // yellow dots
      ctx.fill();
    });

    // Draw connecting lines between nearby particles
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx   = particles[i].x - particles[j].x;
        const dy   = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 90) {
          const alpha = (1 - dist / 90) * 0.08;  // very faint lines
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(255, 214, 10, ${alpha})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    rafId = requestAnimationFrame(draw);
  }

  // ── Track mouse position relative to canvas ───────────────────────────────
  document.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
  });

  // ── Lazy init via IntersectionObserver ────────────────────────────────────
  // Don't start the RAF loop until the hero is actually visible.
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !running) {
        running = true;
        resize();
        draw();
        io.disconnect();
      }
    });
  }, { threshold: 0.1 });

  io.observe(canvas.closest('.hero') || canvas.parentElement);

  // Handle resize
  window.addEventListener('resize', () => {
    if (running) resize();
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// 4. FILM GRAIN OVERLAY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * initFilmGrain()
 *
 * Generates animated noise on a fixed canvas behind everything.
 * Creates that tactile, premium "printed" feel on flat black.
 *
 * HOW IT WORKS:
 * Each frame we randomize pixel brightnesses across a small canvas tile
 * (e.g. 200×200px), then CSS scales it to cover the full viewport.
 * We also CSS-animate it (translate the canvas a few px) to avoid static
 * repetition. The canvas is pointer-events: none and z-index: 1.
 */
function initFilmGrain() {

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'grain-canvas';
  canvas.width  = 220;
  canvas.height = 220;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let frame = 0;

  function drawGrain() {
    // Only redraw every 3 frames to save CPU (still looks good at ~20fps)
    frame++;
    if (frame % 3 === 0) {
      const imageData = ctx.createImageData(220, 220);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 255;
        data[i]     = v;  // R
        data[i + 1] = v;  // G
        data[i + 2] = v;  // B
        data[i + 3] = 20; // A — very low = barely visible
      }
      ctx.putImageData(imageData, 0, 0);
    }
    requestAnimationFrame(drawGrain);
  }

  drawGrain();
}
