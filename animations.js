/**
 * animations.js — Smooth Scroll + Scroll-Triggered Animations
 *
 * STAGE 1 of the premium motion system.
 *
 * WHAT THIS FILE DOES:
 * ─────────────────────────────────────────────────────────────
 * 1. Lenis smooth scroll
 *    Lenis replaces the browser's default scroll with a buttery,
 *    inertia-based scroll that decelerates naturally (like iOS momentum
 *    scrolling but controlled). It must be "ticked" each animation frame
 *    so we hook it into GSAP's ticker for perfect sync.
 *
 * 2. GSAP ScrollTrigger reveals
 *    As elements scroll into view, they animate from
 *    { opacity:0, y:30 } → { opacity:1, y:0 } with a stagger.
 *    Cards scale in from 0.95 → 1.
 *    Background blobs move at a different speed (parallax).
 *
 * 3. Scroll progress bar
 *    A thin yellow bar fixed at the top of the page fills left-to-right.
 *
 * HOW TO ADD MORE ANIMATIONS:
 *    Call gsap.from(element, { ...props, scrollTrigger: { trigger: element } })
 *    anywhere after initAnimations() has run.
 *
 * DEPENDENCY ORDER (in index.html):
 *    <script src="gsap.min.js CDN">     ← must load first
 *    <script src="ScrollTrigger CDN">   ← must load before animations.js
 *    <script src="lenis CDN">           ← must load before animations.js
 *    <script src="animations.js">
 */

/**
 * initAnimations()
 *
 * Call this once after the DOM is ready (and after preloader finishes).
 * Returns the Lenis instance so cursor.js / preloader.js can access scroll state.
 */
function initAnimations() {

  // ── Reduced-motion guard ──────────────────────────────────────────────────
  // If the user has enabled "Reduce motion" in their OS settings, skip all
  // animation setup and return early. Everything still works, just no motion.
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) {
    // Make all animated elements immediately visible
    document.querySelectorAll('[data-reveal]').forEach(el => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. LENIS SMOOTH SCROLL
  // ═══════════════════════════════════════════════════════════════
  // `lerp` controls the "smoothness": 0 = laggy, 1 = instant.
  // 0.08 is a luxurious, magazine-style scroll feel.
  const lenis = new Lenis({
    lerp: 0.09,           // slightly snappier than before — weighty but not sluggish
    duration: 1.1,        // overall scroll duration in seconds (1.0–1.2 is the sweet spot)
    smoothWheel: true,
    syncTouch: false,     // don't override native touch scroll on mobile
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),  // exponential ease-out
  });

  // Connect Lenis to GSAP's RAF loop so they stay in perfect sync.
  // Without this, Lenis and ScrollTrigger would drift apart.
  gsap.ticker.add((time) => {
    lenis.raf(time * 1000); // Lenis expects milliseconds, GSAP gives seconds
  });

  // Prevent GSAP's ticker from using its own lag smoothing,
  // since Lenis handles that itself.
  gsap.ticker.lagSmoothing(0);

  // Tell ScrollTrigger to use Lenis's scroll position instead of window.scrollY
  lenis.on('scroll', ScrollTrigger.update);

  // ═══════════════════════════════════════════════════════════════
  // 2. SCROLL PROGRESS BAR
  // ═══════════════════════════════════════════════════════════════
  const progressBar = document.getElementById('scroll-progress');
  if (progressBar) {
    gsap.to(progressBar, {
      scaleX: 1,
      ease: 'none',
      scrollTrigger: {
        trigger: document.body,
        start: 'top top',
        end: 'bottom bottom',
        scrub: true,   // ties animation progress directly to scroll position
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. SCROLL-TRIGGERED REVEALS
  // ═══════════════════════════════════════════════════════════════
  // We use a data attribute [data-reveal] to mark elements that should
  // animate in. This keeps the JS decoupled from specific class names.
  //
  // data-reveal="fade"      → fade + slide up (default)
  // data-reveal="scale"     → scale in from 0.94
  // data-reveal="stagger"   → parent: children stagger in one-by-one

  // ── Fade + slide-up reveals ───────────────────────────────────────────────
  // gsap.utils.toArray converts a NodeList to an array so we can use .forEach
  gsap.utils.toArray('[data-reveal="fade"]').forEach(el => {
    gsap.from(el, {
      opacity: 0,
      y: 36,
      duration: 0.9,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: el,
        start: 'top 88%',    // trigger when element's top hits 88% down the viewport
        toggleActions: 'play none none none',  // only play once, don't reverse
      },
    });
  });

  // ── Scale-in for cards ────────────────────────────────────────────────────
  gsap.utils.toArray('[data-reveal="scale"]').forEach(el => {
    gsap.from(el, {
      opacity: 0,
      scale: 0.94,
      y: 20,
      duration: 0.85,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: el,
        start: 'top 90%',
        toggleActions: 'play none none none',
      },
    });
  });

  // ── Stagger reveals (children animate in sequence) ────────────────────────
  gsap.utils.toArray('[data-reveal="stagger"]').forEach(parent => {
    const children = parent.children;
    gsap.from(children, {
      opacity: 0,
      y: 28,
      duration: 0.75,
      ease: 'power2.out',
      stagger: 0.12,   // 120ms between each child
      scrollTrigger: {
        trigger: parent,
        start: 'top 85%',
        toggleActions: 'play none none none',
      },
    });
  });

  // ── How-it-works steps: stagger with slight left offset ───────────────────
  const howSteps = document.querySelectorAll('.how-step');
  if (howSteps.length) {
    gsap.from(howSteps, {
      opacity: 0,
      y: 40,
      duration: 0.8,
      ease: 'power3.out',
      stagger: 0.18,
      scrollTrigger: {
        trigger: '.how-steps',
        start: 'top 80%',
        toggleActions: 'play none none none',
      },
    });
  }

  // ── FAQ items: stagger ────────────────────────────────────────────────────
  const faqItems = document.querySelectorAll('.faq-item');
  if (faqItems.length) {
    gsap.from(faqItems, {
      opacity: 0,
      x: -20,
      duration: 0.6,
      ease: 'power2.out',
      stagger: 0.1,
      scrollTrigger: {
        trigger: '.faq-list',
        start: 'top 85%',
        toggleActions: 'play none none none',
      },
    });
  }

  // ── Trust badges: scale-stagger ───────────────────────────────────────────
  const badges = document.querySelectorAll('.trust-badge');
  if (badges.length) {
    gsap.from(badges, {
      opacity: 0,
      scale: 0.85,
      duration: 0.5,
      ease: 'back.out(1.5)',
      stagger: 0.08,
      scrollTrigger: {
        trigger: '.trust-badges',
        start: 'top 88%',
        toggleActions: 'play none none none',
      },
    });
  }

  // ── Parallax on background orbs ───────────────────────────────────────────
  // Background elements move at 30% of the scroll speed (slower = depth illusion)
  const orbs = document.querySelectorAll('.bg-orb');
  orbs.forEach((orb, i) => {
    const direction = i % 2 === 0 ? -1 : 1;
    gsap.to(orb, {
      y: direction * 120,
      ease: 'none',
      scrollTrigger: {
        trigger: document.body,
        start: 'top top',
        end: 'bottom bottom',
        scrub: 1.5,  // scrub with 1.5s lag for smoothness
      },
    });
  });

  // ── Section background transitions ───────────────────────────────────────
  // Each major section subtly shifts the page background color as it enters.
  // We animate a CSS variable on the body.
  const sections = [
    { el: '.how-section',  bg: '#0D0D0D' },
    { el: '.faq-section',  bg: '#0A0A0A' },
    { el: '.footer',       bg: '#080808' },
  ];

  sections.forEach(({ el, bg }) => {
    const node = document.querySelector(el);
    if (!node) return;
    ScrollTrigger.create({
      trigger: node,
      start: 'top 60%',
      end: 'bottom 40%',
      onEnter:      () => gsap.to('body', { backgroundColor: bg, duration: 0.8, ease: 'power1.out' }),
      onLeaveBack:  () => gsap.to('body', { backgroundColor: '#0A0A0A', duration: 0.8, ease: 'power1.out' }),
    });
  });

  // ── Section divider lines animate width ──────────────────────────────────
  gsap.utils.toArray('.section-divider').forEach(el => {
    gsap.from(el, {
      scaleX: 0,
      transformOrigin: 'left center',
      duration: 1.2,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: el,
        start: 'top 90%',
        toggleActions: 'play none none none',
      },
    });
  });

  return lenis;
}



// ══════════════════════════════════════════════════════════════════════════════
// TEAR PAGE TRANSITION EFFECT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * initTearTransitions()
 *
 * Animates a jagged torn-paper SVG edge between major sections as they
 * scroll into view. The tear "reveals" each section by animating a
 * clip-path from a compact line to its full jagged shape.
 *
 * HOW IT WORKS:
 *   Each .section-tear div gets an absolutely-positioned SVG with a
 *   jagged path. On scroll, we animate the SVG's translateY and opacity
 *   to create the illusion of a page being torn open.
 *
 *   We use clip-path animation on a pseudo-element rather than moving
 *   actual layout elements — 100% GPU-accelerated, zero layout cost.
 *
 *   `toggleActions: 'play none none reverse'` means the tear plays on
 *   scroll-enter and reverses on scroll-back — no flickering.
 *
 * PERFORMANCE:
 *   - Only transform + opacity animated (GPU layers, no reflow)
 *   - SVG is position: absolute, so it's out of document flow
 *   - Respects prefers-reduced-motion (skipped entirely if set)
 */
function initTearTransitions() {

  // Reduced motion: skip entirely
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // The jagged SVG path — an irregular zigzag simulating a torn paper edge.
  // viewBox is 1440 x 40 (full-width, 40px tall).
  // The path traces a ragged horizontal line from left to right.
  const TEAR_PATH = `
    M0,20 L60,8 L120,28 L180,6 L240,24 L300,10 L360,26 L420,4 L480,22
    L540,12 L600,28 L660,8 L720,24 L780,14 L840,30 L900,6 L960,22
    L1020,10 L1080,26 L1140,8 L1200,24 L1260,14 L1320,28 L1380,10 L1440,20
    L1440,40 L0,40 Z
  `;

  document.querySelectorAll('.section-tear').forEach((tearEl, i) => {

    // Build the SVG tear element
    const ns  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 1440 40');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('tear-svg');

    // Dark fill (matches --bg-base) — hides the section above
    const fill = document.createElementNS(ns, 'path');
    fill.setAttribute('d', TEAR_PATH);
    fill.setAttribute('fill', '#0A0A0A');
    svg.appendChild(fill);

    // Thin yellow highlight line along the tear edge (the "tear line")
    const highlight = document.createElementNS(ns, 'path');
    highlight.setAttribute('d', `M0,20 L60,8 L120,28 L180,6 L240,24 L300,10 L360,26
      L420,4 L480,22 L540,12 L600,28 L660,8 L720,24 L780,14 L840,30
      L900,6 L960,22 L1020,10 L1080,26 L1140,8 L1200,24 L1260,14
      L1320,28 L1380,10 L1440,20`);
    highlight.setAttribute('fill', 'none');
    highlight.setAttribute('stroke', 'rgba(255, 214, 10, 0.35)');
    highlight.setAttribute('stroke-width', '1.5');
    svg.appendChild(highlight);

    tearEl.appendChild(svg);

    // ── GSAP ScrollTrigger animation ────────────────────────────────────────
    // The SVG starts translated 100% upward (hidden above) and slides down
    // into position as the section scrolls in. Combined with opacity.
    //
    // This creates the "tear opens" illusion — as if the section above is
    // being peeled away from the one below.
    gsap.fromTo(svg,
      // FROM state — tear starts above view, invisible
      { y: '-60px', opacity: 0, scaleY: 0.3, transformOrigin: 'center top' },
      // TO state — tear settles into its natural position
      {
        y: '0px',
        opacity: 1,
        scaleY: 1,
        duration: 0.8,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: tearEl,
          start: 'top 85%',
          end: 'top 50%',
          // play on enter, reverse on scroll back
          toggleActions: 'play none none reverse',
          // fastScrollEnd prevents the reverse from firing on quick scroll
          fastScrollEnd: true,
        },
      }
    );

    // Subtle shadow beneath the tear (a blurred rectangle via box-shadow on the container)
    tearEl.style.filter = 'drop-shadow(0 4px 12px rgba(0,0,0,0.6))';
  });
}
