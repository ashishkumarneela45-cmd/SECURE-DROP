/**
 * settings.js — Expiry Picker & Download Limit Picker
 *
 * Two self-contained modules:
 *
 *   initExpiryPicker()
 *     Manages the "Expires in" section.
 *     Quick-select buttons auto-fill the number + unit inputs.
 *     Validates: min 1 min, max 30 days.
 *     Shows a live "expires on" date/time preview.
 *     Returns: { getExpirySeconds() }
 *
 *   initDownloadLimitPicker()
 *     Manages the "Max downloads" section.
 *     Quick-select buttons auto-fill the number input.
 *     "Unlimited" checkbox disables the number input.
 *     Validates: 1–1000.
 *     Returns: { getMaxDownloads() }  (0 = unlimited)
 *
 * How to use (in app.js):
 *   const { getExpirySeconds } = initExpiryPicker();
 *   const { getMaxDownloads  } = initDownloadLimitPicker();
 *   // then in the upload handler:
 *   const expirySeconds = getExpirySeconds();
 *   const maxDownloads  = getMaxDownloads();
 */

// ══════════════════════════════════════════════════════════════════
// EXPIRY PICKER
// ══════════════════════════════════════════════════════════════════

/**
 * Seconds in each unit — used to convert value+unit → seconds
 * and to fill the picker from a preset.
 */
const UNIT_SECONDS = {
  minutes: 60,
  hours:   3600,
  days:    86400,
};

const EXPIRY_MIN_SECONDS = 60;                // 1 minute
const EXPIRY_MAX_SECONDS = 30 * 24 * 3600;   // 30 days

/**
 * initExpiryPicker()
 *
 * Wires up:
 *   - Quick-select buttons (#expiry-quick-*)
 *   - Value input (#expiry-value)
 *   - Unit select (#expiry-unit)
 *   - Live preview (#expiry-preview)
 *   - Error message (#expiry-error)
 *
 * @returns {{ getExpirySeconds: () => number | null }}
 *   Returns null if current value is invalid.
 */
function initExpiryPicker() {
  const valueInput   = document.getElementById('expiry-value');
  const unitSelect   = document.getElementById('expiry-unit');
  const preview      = document.getElementById('expiry-preview');
  const errorEl      = document.getElementById('expiry-error');
  const quickBtns    = document.querySelectorAll('[data-expiry-preset]');

  // ── Quick-select buttons ────────────────────────────────────────
  // Each button has data-expiry-preset="<seconds>" and data-expiry-label="<N> <unit>"
  quickBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Remove active state from all
      quickBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const seconds = parseInt(btn.dataset.expiryPreset, 10);
      fillPickerFromSeconds(seconds);
      validateAndPreview();
    });
  });

  // ── Value / unit change ─────────────────────────────────────────
  valueInput.addEventListener('input', () => {
    // Clear active state on quick-select when user types
    quickBtns.forEach(b => b.classList.remove('active'));
    validateAndPreview();
  });
  unitSelect.addEventListener('change', () => {
    quickBtns.forEach(b => b.classList.remove('active'));
    validateAndPreview();
  });

  /**
   * Given a total seconds value, fill the value+unit inputs
   * with the most appropriate unit (e.g. 3600 → "1 hours").
   */
  function fillPickerFromSeconds(seconds) {
    if (seconds >= UNIT_SECONDS.days && seconds % UNIT_SECONDS.days === 0) {
      valueInput.value = seconds / UNIT_SECONDS.days;
      unitSelect.value = 'days';
    } else if (seconds >= UNIT_SECONDS.hours && seconds % UNIT_SECONDS.hours === 0) {
      valueInput.value = seconds / UNIT_SECONDS.hours;
      unitSelect.value = 'hours';
    } else {
      valueInput.value = seconds / UNIT_SECONDS.minutes;
      unitSelect.value = 'minutes';
    }
  }

  /**
   * Validates the current picker value, shows an error or a preview.
   * Returns true if valid.
   */
  function validateAndPreview() {
    const val  = parseFloat(valueInput.value);
    const unit = unitSelect.value;
    const secs = val * UNIT_SECONDS[unit];

    if (!val || isNaN(val) || val <= 0) {
      showError('Enter a value greater than 0.');
      clearPreview();
      return false;
    }
    if (secs < EXPIRY_MIN_SECONDS) {
      showError('Minimum expiry is 1 minute.');
      clearPreview();
      return false;
    }
    if (secs > EXPIRY_MAX_SECONDS) {
      showError('Maximum expiry is 30 days.');
      clearPreview();
      return false;
    }

    hideError();
    showPreview(secs);
    return true;
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    valueInput.setAttribute('aria-invalid', 'true');
  }

  function hideError() {
    errorEl.classList.add('hidden');
    valueInput.removeAttribute('aria-invalid');
  }

  function showPreview(secs) {
    const expiresAt = new Date(Date.now() + secs * 1000);
    // Format: "Mon, 6 Sep 2026 at 2:45 PM"
    const formatted = expiresAt.toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    preview.textContent = `Expires on ${formatted}`;
    preview.classList.remove('hidden');
  }

  function clearPreview() {
    preview.textContent = '';
    preview.classList.add('hidden');
  }

  // ── Set default on load: 24 hours ──────────────────────────────
  fillPickerFromSeconds(86400);
  // Activate the "24 hrs" quick button
  const defaultBtn = document.querySelector('[data-expiry-preset="86400"]');
  if (defaultBtn) defaultBtn.classList.add('active');
  validateAndPreview();

  // ── Public API ─────────────────────────────────────────────────

  function getExpirySeconds() {
    const val  = parseFloat(valueInput.value);
    const unit = unitSelect.value;
    const secs = Math.round(val * UNIT_SECONDS[unit]);
    if (!validateAndPreview()) return null;
    return secs;
  }

  return { getExpirySeconds };
}


// ══════════════════════════════════════════════════════════════════
// DOWNLOAD LIMIT PICKER
// ══════════════════════════════════════════════════════════════════

const DL_MAX = 1000;

/**
 * initDownloadLimitPicker()
 *
 * Wires up:
 *   - Quick-select buttons ([data-dl-preset])
 *   - Number input (#dl-limit-value)
 *   - Unlimited checkbox (#dl-unlimited)
 *   - Error message (#dl-limit-error)
 *
 * @returns {{ getMaxDownloads: () => number }}
 *   Returns 0 for unlimited.
 */
function initDownloadLimitPicker() {
  const valueInput  = document.getElementById('dl-limit-value');
  const unlimitedCb = document.getElementById('dl-unlimited');
  const errorEl     = document.getElementById('dl-limit-error');
  const quickBtns   = document.querySelectorAll('[data-dl-preset]');

  let isUnlimited = false;

  // ── Quick-select buttons ────────────────────────────────────────
  quickBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.dlPreset;

      if (val === 'unlimited') {
        // Check the unlimited checkbox
        unlimitedCb.checked = true;
        unlimitedCb.dispatchEvent(new Event('change'));
      } else {
        // Uncheck unlimited, set value
        unlimitedCb.checked = false;
        unlimitedCb.dispatchEvent(new Event('change'));
        valueInput.value = val;
        validate();
      }

      quickBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ── Value input ─────────────────────────────────────────────────
  valueInput.addEventListener('input', () => {
    quickBtns.forEach(b => b.classList.remove('active'));
    validate();
  });

  // ── Unlimited checkbox ──────────────────────────────────────────
  unlimitedCb.addEventListener('change', () => {
    isUnlimited = unlimitedCb.checked;

    if (isUnlimited) {
      valueInput.disabled = true;
      valueInput.setAttribute('aria-disabled', 'true');
      valueInput.classList.add('disabled');
      hideError();
    } else {
      valueInput.disabled = false;
      valueInput.removeAttribute('aria-disabled');
      valueInput.classList.remove('disabled');
      validate();
    }
  });

  function validate() {
    if (isUnlimited) { hideError(); return true; }

    const val = parseInt(valueInput.value, 10);
    if (!val || isNaN(val) || val < 1) {
      showError('Minimum is 1 download.');
      return false;
    }
    if (val > DL_MAX) {
      showError(`Maximum is ${DL_MAX} downloads.`);
      return false;
    }
    hideError();
    return true;
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    valueInput.setAttribute('aria-invalid', 'true');
  }

  function hideError() {
    errorEl.classList.add('hidden');
    if (valueInput) valueInput.removeAttribute('aria-invalid');
  }

  // ── Default: 1 download ─────────────────────────────────────────
  valueInput.value = '1';
  const defaultBtn = document.querySelector('[data-dl-preset="1"]');
  if (defaultBtn) defaultBtn.classList.add('active');

  // ── Public API ──────────────────────────────────────────────────

  function getMaxDownloads() {
    if (isUnlimited) return 0;
    return parseInt(valueInput.value, 10) || 1;
  }

  return { getMaxDownloads };
}
