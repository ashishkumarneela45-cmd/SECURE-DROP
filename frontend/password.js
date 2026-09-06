/**
 * password.js — Password Protection Module
 *
 * Handles everything related to optional password protection on the upload side:
 *   - Toggle to enable/disable password protection
 *   - Two modes: "own password" (with strength meter) vs "auto-generate"
 *   - Show/hide password eye icon
 *   - Auto-generated password display with copy button
 *
 * This module exposes one function: initPasswordProtection()
 * Call it once on page load. It manages its own DOM and returns
 * a getPassword() function the upload flow uses to read the chosen password.
 *
 * SECURITY NOTE:
 * The password is used ONLY as input to PBKDF2 in crypto.js to wrap the
 * file encryption key. The password itself is never sent to the server.
 * It lives only in a JS variable here and is cleared on page reload.
 */

/**
 * Curated word list for auto-generated readable codes.
 * Words are: short (4–7 letters), common, easy to spell, unambiguous.
 * Deliberately excludes: "l/1/0/O" look-alike letters at start,
 * offensive words, words with confusing homophones.
 *
 * Security note: the short code (e.g. "Tiger47") is an ADDITIONAL layer
 * on top of the 256-bit AES key in the URL fragment. The URL key provides
 * the cryptographic strength; this code adds a human-shareable second factor
 * that can be sent via a separate channel (e.g. SMS vs email).
 * Even a "weak-looking" 8-char code adds meaningful protection because
 * the server locks the link after 5 failed attempts.
 */
const WORD_LIST = [
  // Animals
  'Tiger','Panda','Cobra','Eagle','Shark','Bison','Crane','Raven',
  'Otter','Viper','Falcon','Badger','Moose','Zebra','Lynx','Bison',
  'Koala','Gecko','Robin','Heron','Finch','Lemur','Puffin','Stork',
  // Nature
  'Storm','Frost','Cedar','Maple','Birch','Amber','Pearl','Coral',
  'Lunar','Solar','River','Ocean','Cloud','Ember','Flame','Boulder',
  // Objects
  'Rocket','Anchor','Bridge','Castle','Lantern','Compass','Beacon',
  'Mirror','Prism','Crystal','Forge','Vault','Tower','Helm','Cabin',
  // Colours/concepts
  'Violet','Indigo','Cobalt','Jade','Crimson','Bronze','Silver',
  'Onyx','Ivory','Scarlet','Azure','Tawny',
];

/**
 * Generates a readable code: one word + 2-digit number, e.g. "Tiger47"
 * Displayed as "TIGER 47" for easy reading aloud.
 *
 * Format returned: "Tiger47"  (the display logic adds the space)
 *
 * @returns {{ code: string, display: string }}
 *   code    — the actual password string used for PBKDF2 ("Tiger47")
 *   display — the human-readable spaced version ("TIGER 47")
 */
function generateReadableCode() {
  const word   = WORD_LIST[randomInt(WORD_LIST.length)];
  // Two-digit number: 10–99 (avoid 00–09 which look like 1-digit numbers)
  const number = 10 + randomInt(90);
  const code   = word + number;
  const display = word.toUpperCase() + ' ' + number;
  return { code, display };
}

/** Pick a random character from a string using crypto.getRandomValues */
function randomChar(str) {
  return str[randomInt(str.length)];
}

/** Generate a cryptographically random integer in [0, max) */
function randomInt(max) {
  // Use rejection sampling to avoid modulo bias
  const limit = Math.floor(256 / max) * max;
  const buf = new Uint8Array(1);
  let val;
  do {
    crypto.getRandomValues(buf);
    val = buf[0];
  } while (val >= limit);
  return val % max;
}

/**
 * Evaluates password strength on a 0–3 scale.
 *
 * Returns: { score: 0|1|2|3, label: 'Weak'|'Fair'|'Strong'|'Very strong' }
 *
 * Rules (each adds to score):
 *   - Length ≥ 10
 *   - Contains both upper and lowercase
 *   - Contains a digit
 *   - Contains a symbol
 *
 * @param {string} password
 * @returns {{ score: number, label: string }}
 */
function evaluatePasswordStrength(password) {
  if (!password) return { score: 0, label: '' };

  let score = 0;
  if (password.length >= 10) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  const labels = ['Weak', 'Fair', 'Strong', 'Very strong'];
  const label = password.length < 4 ? 'Too short' : labels[score - 1] || 'Weak';

  return { score, label };
}

/**
 * initPasswordProtection()
 *
 * Wires up all the password-related DOM interactions.
 * Call once during page init.
 *
 * @returns {{ getPassword: () => string }}
 *   getPassword() returns the current password (empty string if protection disabled)
 */
function initPasswordProtection() {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const toggle        = document.getElementById('pw-toggle');
  const toggleLabel   = document.getElementById('pw-toggle-label');
  const pwPanel       = document.getElementById('pw-panel');
  const modeOwn       = document.getElementById('pw-mode-own');
  const modeAuto      = document.getElementById('pw-mode-auto');
  const ownSection    = document.getElementById('pw-own-section');
  const autoSection   = document.getElementById('pw-auto-section');
  const ownInput      = document.getElementById('pw-own-input');
  const eyeBtn        = document.getElementById('pw-eye-btn');
  const strengthBar   = document.getElementById('pw-strength-bar');
  const strengthLabel = document.getElementById('pw-strength-label');
  const autoDisplay   = document.getElementById('pw-auto-display');
  const genBtn        = document.getElementById('pw-gen-btn');
  const autoCopyBtn   = document.getElementById('pw-auto-copy-btn');

  // The active password value — stored in JS memory only, never in DOM storage
  let currentPassword = '';
  let protectionEnabled = false;

  // ── Toggle enable/disable ─────────────────────────────────────────────────

  toggle.addEventListener('change', () => {
    protectionEnabled = toggle.checked;
    toggleLabel.textContent = protectionEnabled ? 'Password protection on' : 'Protect with password';
    if (protectionEnabled) {
      show(pwPanel);
      // Default to "own password" mode
      modeOwn.checked = true;
      showOwnSection();
    } else {
      hide(pwPanel);
      currentPassword = '';
      ownInput.value = '';
      autoDisplay.value = '';
      resetStrengthMeter();
    }
  });

  // ── Mode radio buttons ────────────────────────────────────────────────────

  modeOwn.addEventListener('change', () => {
    if (modeOwn.checked) showOwnSection();
  });

  modeAuto.addEventListener('change', () => {
    if (modeAuto.checked) showAutoSection();
  });

  function showOwnSection() {
    show(ownSection);
    hide(autoSection);
    // Sync password from own input
    currentPassword = ownInput.value;
  }

  function showAutoSection() {
    hide(ownSection);
    show(autoSection);
    // Auto-generate immediately when switching to this mode
    if (!autoDisplay.dataset.actualCode) generateAndShow();
    else currentPassword = autoDisplay.dataset.actualCode;
  }

  // ── Own password: show/hide eye toggle ───────────────────────────────────

  eyeBtn.addEventListener('click', () => {
    const isHidden = ownInput.type === 'password';
    ownInput.type = isHidden ? 'text' : 'password';
    // Swap eye icon
    eyeBtn.innerHTML = isHidden ? EYE_OFF_SVG : EYE_SVG;
    eyeBtn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  });

  // ── Own password: live strength meter ────────────────────────────────────

  ownInput.addEventListener('input', () => {
    currentPassword = ownInput.value;
    updateStrengthMeter(currentPassword);
  });

  function updateStrengthMeter(pw) {
    const { score, label } = evaluatePasswordStrength(pw);
    // score 0–4 → 0–100% in 4 steps
    const pct = pw.length === 0 ? 0 : Math.max(25, score * 25);
    strengthBar.style.width = pct + '%';
    strengthBar.className = 'pw-strength-fill pw-strength-' + (score === 0 ? 1 : score);
    strengthLabel.textContent = label;
    strengthLabel.className = 'pw-strength-label pw-score-' + (score === 0 ? 1 : score);
  }

  function resetStrengthMeter() {
    strengthBar.style.width = '0%';
    strengthBar.className = 'pw-strength-fill';
    strengthLabel.textContent = '';
  }

  // ── Auto-generate ─────────────────────────────────────────────────────────

  genBtn.addEventListener('click', generateAndShow);

  function generateAndShow() {
    const { code, display } = generateReadableCode();
    // Store the actual password value (used by PBKDF2 in crypto.js)
    currentPassword = code;
    // Show the human-readable spaced version ("TIGER 47") in the display field
    autoDisplay.value = display;
    // Keep the actual code as a data attribute for the copy button
    autoDisplay.dataset.actualCode = code;
  }

  // ── Copy auto-generated password ─────────────────────────────────────────

  autoCopyBtn.addEventListener('click', async () => {
    // Copy the actual code WITHOUT the display space (e.g. "Tiger47", not "TIGER 47")
    // so the recipient can type it directly as a password
    const codeToCopy = autoDisplay.dataset.actualCode || autoDisplay.value.replace(/\s+/g, '');
    if (!codeToCopy) return;
    try {
      await navigator.clipboard.writeText(codeToCopy);
      autoCopyBtn.textContent = '✓ Copied!';
      autoCopyBtn.classList.add('copied');
      setTimeout(() => {
        autoCopyBtn.textContent = 'Copy';
        autoCopyBtn.classList.remove('copied');
      }, 2000);
    } catch {
      autoDisplay.select();
    }
  });

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns the current password.
   * Empty string means no password protection.
   */
  function getPassword() {
    return protectionEnabled ? currentPassword : '';
  }

  return { getPassword };
}

// ── SVG constants for eye icons ───────────────────────────────────────────────

const EYE_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`;

const EYE_OFF_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true">
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>`;

// ── Tiny show/hide helpers (duplicated from app.js so this file is standalone) ─
function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }
