/**
 * app.js — SecureDrop UI logic
 *
 * This file handles two distinct flows depending on the URL:
 *
 *  1. UPLOAD FLOW (no # fragment, or # doesn't contain a file ID)
 *     - User picks a file, selects settings
 *     - crypto.js encrypts the file in the browser
 *     - We upload the ciphertext to the backend
 *     - We show a share link with the key embedded in the # fragment
 *
 *  2. DOWNLOAD FLOW (# fragment contains fileId:key)
 *     - We read the key from window.location.hash (browser never sends this to server)
 *     - Fetch the encrypted blob from /api/file/:id
 *     - crypto.js decrypts it locally
 *     - Trigger a browser download of the plaintext file
 */

const API_BASE = ''; // same origin — backend serves frontend

// ── Utility helpers ───────────────────────────────────────────────────────────

/** Format bytes as a human-readable string (KB / MB / GB) */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * Format a duration in seconds as a human-readable string.
 * e.g. 90 → "1h 30m", 604800 → "7 days", 600 → "10 minutes"
 */
function formatDuration(seconds) {
  const days  = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins  = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days)  parts.push(`${days} day${days  !== 1 ? 's' : ''}`);
  if (hours) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  if (mins && !days) parts.push(`${mins} minute${mins !== 1 ? 's' : ''}`);
  return parts.join(' ') || '< 1 minute';
}

/**
 * Format a countdown from now until expiresAt.
 * Returns a string like "2d 3h 14m 05s" that updates every second.
 * Returns "Expired" when time is up.
 */
function formatCountdown(expiresAt) {
  const diff = Math.max(0, expiresAt - Date.now());
  if (diff === 0) return 'Expired';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  const pad = n => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  if (h > 0) return `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  return `${pad(m)}m ${pad(s)}s`;
}

/** Format a unix timestamp as a relative time (e.g. "in 23 hours") */
function formatExpiry(expiresAt) {
  const diff = expiresAt - Date.now();
  if (diff <= 0) return 'Expired';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 24) return `Expires in ${Math.floor(hours / 24)} day(s)`;
  if (hours > 0) return `Expires in ${hours}h ${mins}m`;
  return `Expires in ${mins} minute(s)`;
}

/** Show/hide an element by toggling the 'hidden' class */
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

/**
 * Update the progress bar, label and percentage display.
 * Also updates aria-valuenow for screen readers.
 */
function setProgress(barEl, labelEl, pctEl, pct, label) {
  barEl.style.width = pct + '%';
  if (labelEl) labelEl.textContent = label;
  if (pctEl) pctEl.textContent = pct + '%';
  // Update ARIA attribute for screen readers
  const track = barEl.closest('[role="progressbar"]');
  if (track) track.setAttribute('aria-valuenow', pct);
}

// ── Route: decide which page to show ─────────────────────────────────────────

/**
 * Reads the URL hash. If it looks like a file share link (contains ":"),
 * show the download page. Otherwise show the upload page.
 */
function routePage() {
  const hash = window.location.hash;
  const parsed = hash ? SecureCrypto.parseFragment(hash) : null;

  if (parsed && parsed.fileId && parsed.keyB64) {
    // Download page
    show(document.getElementById('download-page'));
    hide(document.getElementById('upload-page'));
    initDownloadPage(parsed);
  } else {
    // Upload page
    show(document.getElementById('upload-page'));
    hide(document.getElementById('download-page'));
    initUploadPage();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// UPLOAD PAGE
// ═════════════════════════════════════════════════════════════════════════════

function initUploadPage() {
  const dropZone       = document.getElementById('drop-zone');
  const fileInput      = document.getElementById('file-input');
  const uploadBtn      = document.getElementById('upload-btn');
  const fileInfo       = document.getElementById('file-info');
  const changeFileBtn  = document.getElementById('change-file-btn');
  const progressArea   = document.getElementById('progress-area');
  const progressBar    = document.getElementById('progress-bar');
  const progressLabel  = document.getElementById('progress-label');
  const progressPct    = document.getElementById('progress-pct');
  const successSection = document.getElementById('success-section');
  const uploadSection  = document.getElementById('upload-section');
  const uploadAnotherBtn = document.getElementById('upload-another-btn');
  const copyBtn        = document.getElementById('copy-btn');
  const shareBtn       = document.getElementById('share-btn');

  let selectedFile = null;

  // ── Initialize the password protection module ─────────────────────────
  // password.js exposes initPasswordProtection() which wires up the toggle,
  // modes, strength meter, and auto-generate — returns getPassword().
  const { getPassword } = initPasswordProtection();

  // ── Initialize expiry + download limit pickers ────────────────────────
  // settings.js exposes these two initializers, each returning a getter.
  const { getExpirySeconds  } = initExpiryPicker();
  const { getMaxDownloads   } = initDownloadLimitPicker();

  // ── File selection ──────────────────────────────────────────────────────

  /** Called whenever a file is chosen (drag-drop or click) */
  function setFile(file) {
    selectedFile = file;
    document.getElementById('selected-file-name').textContent = file.name;
    document.getElementById('selected-file-size').textContent = formatSize(file.size);
    show(fileInfo);
    uploadBtn.disabled = false;
    uploadBtn.setAttribute('aria-disabled', 'false');
  }

  // Drag and drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', (e) => {
    // Only remove if leaving the drop zone itself (not entering a child)
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drag-over');
    }
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });

  // Click or keyboard to browse
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setFile(fileInput.files[0]);
  });

  // Change/remove file
  changeFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedFile = null;
    fileInput.value = '';
    hide(fileInfo);
    uploadBtn.disabled = true;
    uploadBtn.setAttribute('aria-disabled', 'true');
  });

  // ── Upload flow ────────────────────────────────────────────────────────

  uploadBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    // Read settings from pickers (settings.js)
    const expirySeconds = getExpirySeconds();
    const maxDownloads  = getMaxDownloads();

    // Validate expiry (picker returns null if invalid)
    if (expirySeconds === null) {
      uploadBtn.disabled = false;
      hide(progressArea);
      return;
    }

    // Get password from the password module (empty string = no protection)
    const password = getPassword();

    // Disable UI during upload
    uploadBtn.disabled = true;
    show(progressArea);
    hide(fileInfo);

    try {
      // ── STEP 1: Read file as ArrayBuffer ────────────────────────────────
      setProgress(progressBar, progressLabel, progressPct, 5, 'Reading file…');
      const fileBuffer = await readFileAsBuffer(selectedFile);

      // ── STEP 2: Generate a random AES-256 encryption key ────────────────
      // This key will encrypt the file. It never leaves the browser.
      setProgress(progressBar, progressLabel, progressPct, 15, 'Generating encryption key…');
      const fileKey = await SecureCrypto.generateFileKey();

      // ── STEP 3: Encrypt the file bytes ───────────────────────────────────
      // AES-GCM produces: [12-byte IV][ciphertext + 16-byte auth tag]
      setProgress(progressBar, progressLabel, progressPct, 30, 'Encrypting file…');
      const encryptedFile = await SecureCrypto.encryptFile(fileKey, fileBuffer);

      // ── STEP 4: Encrypt metadata (original filename + MIME type) ────────
      // The server will store this too, but it's encrypted — server can't read it.
      setProgress(progressBar, progressLabel, progressPct, 50, 'Encrypting metadata…');
      const encryptedMeta = await SecureCrypto.encryptMeta(fileKey, {
        name: selectedFile.name,
        type: selectedFile.type || 'application/octet-stream',
      });

      // ── STEP 5: Optionally wrap the key with a password ──────────────────
      setProgress(progressBar, progressLabel, progressPct, 60, 'Preparing share link…');
      let keyForUrl;
      const hasPassword = password.length > 0;
      if (hasPassword) {
        keyForUrl = await SecureCrypto.wrapKeyWithPassword(fileKey, password);
      } else {
        keyForUrl = await SecureCrypto.exportKeyToBase64(fileKey);
      }

      // ── STEP 6: Upload the encrypted blob to the server ──────────────────
      setProgress(progressBar, progressLabel, progressPct, 70, 'Uploading encrypted file…');

      const formData = new FormData();
      formData.append('encryptedFile', new Blob([encryptedFile], { type: 'application/octet-stream' }), 'encrypted.bin');
      formData.append('encryptedMeta', encryptedMeta);
      formData.append('expirySeconds', expirySeconds.toString());
      formData.append('maxDownloads', maxDownloads.toString());

      const response = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const { id: fileId } = await response.json();

      // ── STEP 7: Build the share URL ──────────────────────────────────────
      // The key lives after # (the fragment). Browsers NEVER send the fragment
      // to the server in HTTP requests. This is the core security guarantee.
      setProgress(progressBar, progressLabel, progressPct, 95, 'Almost done…');
      const fragment = SecureCrypto.buildFragment(fileId, keyForUrl, hasPassword);
      const shareUrl = `${window.location.origin}${window.location.pathname}${fragment}`;

      // ── Show success UI ──────────────────────────────────────────────────
      setProgress(progressBar, progressLabel, progressPct, 100, 'Uploaded!');

      setTimeout(() => {
        hide(progressArea);
        hide(uploadSection);
        showSuccess(shareUrl, expirySeconds, maxDownloads, hasPassword);
      }, 500);

    } catch (err) {
      console.error('Upload error:', err);
      hide(progressArea);
      show(fileInfo);
      uploadBtn.disabled = false;
      alert(`Error: ${err.message}\n\nPlease try again.`);
    }
  });

  // ── Success display ────────────────────────────────────────────────────

  function showSuccess(shareUrl, expirySeconds, maxDownloads, hasPassword) {
    show(successSection);

    const shareLinkInput = document.getElementById('share-link');
    shareLinkInput.value = shareUrl;

    // Expiry / download warning — format any duration cleanly
    const expiryLabel = formatDuration(expirySeconds);
    const dlLabel = maxDownloads === 0 ? 'unlimited downloads' : `${maxDownloads} download${maxDownloads !== 1 ? 's' : ''}`;
    const pwNote = hasPassword ? ' A password is required to decrypt it.' : '';
    document.getElementById('warning-text').textContent =
      `Anyone with this link can access the file for ${expiryLabel} or ${dlLabel}.${pwNote}`;

    // Generate QR code
    generateQRCode(shareUrl);

    // Mobile share button (Web Share API)
    if (shareBtn && navigator.share) {
      show(shareBtn);
      shareBtn.onclick = () => {
        navigator.share({
          title: 'SecureDrop — Encrypted File',
          text: 'Here is an encrypted file for you. Only you can decrypt it with this link.',
          url: shareUrl,
        }).catch(() => {}); // User cancelled share — ignore
      };
    }
  }

  // ── Copy link button ────────────────────────────────────────────────────
  copyBtn.addEventListener('click', async () => {
    const link = document.getElementById('share-link').value;
    try {
      await navigator.clipboard.writeText(link);

      document.getElementById('copy-label').textContent = 'Copied!';
      copyBtn.classList.add('copied');
      document.getElementById('copy-icon').innerHTML = `
        <polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      `;
      showToast('Link copied to clipboard', 'success');

      setTimeout(() => {
        document.getElementById('copy-label').textContent = 'Copy link';
        copyBtn.classList.remove('copied');
        document.getElementById('copy-icon').innerHTML = `
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
        `;
      }, 2200);
    } catch {
      document.getElementById('share-link').select();
    }
  });

  // ── Upload another file — reset the UI ───────────────────────────────
  uploadAnotherBtn.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    hide(fileInfo);
    hide(successSection);
    uploadBtn.disabled = true;
    uploadBtn.setAttribute('aria-disabled', 'true');
    show(uploadSection);
    // Clear QR canvas
    const canvas = document.getElementById('qr-canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    hide(document.getElementById('qr-container'));
  });
}

/** Read a File object as an ArrayBuffer */
function readFileAsBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** Generate a QR code on the canvas element */
function generateQRCode(url) {
  const container = document.getElementById('qr-container');
  const canvas = document.getElementById('qr-canvas');

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const tempDiv = document.createElement('div');
  tempDiv.style.display = 'none';
  document.body.appendChild(tempDiv);

  new QRCode(tempDiv, {
    text: url,
    width: 160,
    height: 160,
    colorDark: '#1a1c30',   // dark indigo squares
    colorLight: '#ffffff',  // white background
  });

  setTimeout(() => {
    const generated = tempDiv.querySelector('canvas');
    if (generated) {
      canvas.width = generated.width;
      canvas.height = generated.height;
      ctx.drawImage(generated, 0, 0);
    }
    document.body.removeChild(tempDiv);
    show(container);
  }, 100);
}

// ═════════════════════════════════════════════════════════════════════════════
// DOWNLOAD PAGE
// ═════════════════════════════════════════════════════════════════════════════

async function initDownloadPage(parsed) {
  const { fileId, keyB64, passwordProtected } = parsed;

  const dlLoading         = document.getElementById('dl-loading');
  const dlReady           = document.getElementById('dl-ready');
  const dlError           = document.getElementById('dl-error');
  const dlBtn             = document.getElementById('dl-btn');
  const dlProgressArea    = document.getElementById('dl-progress-area');
  const dlProgressBar     = document.getElementById('dl-progress-bar');
  const dlProgressLabel   = document.getElementById('dl-progress-label');
  const dlProgressPct     = document.getElementById('dl-progress-pct');
  const dlProgressSub     = document.getElementById('dl-progress-sub');
  const dlPasswordSection = document.getElementById('dl-password-section');
  const dlPwError         = document.getElementById('dl-pw-error');
  const dlPwErrorText     = document.getElementById('dl-pw-error-text');
  const dlPwAttempts      = document.getElementById('dl-pw-attempts');
  const dlPwEyeBtn        = document.getElementById('dl-pw-eye-btn');
  const dlPwInput         = document.getElementById('dl-password-input');

  // Track failed password attempts locally (mirrors server count)
  let failedAttempts = 0;
  const MAX_ATTEMPTS = 5;
  let isLockedOut = false;

  // Show/hide password eye on download page
  if (dlPwEyeBtn && dlPwInput) {
    dlPwEyeBtn.addEventListener('click', () => {
      const isHidden = dlPwInput.type === 'password';
      dlPwInput.type = isHidden ? 'text' : 'password';
      dlPwEyeBtn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    });
  }

  /** Show the error panel */
  function showError(title, msg) {
    hide(dlLoading);
    hide(dlReady);
    show(dlError);
    document.getElementById('dl-error-title').textContent = title;
    document.getElementById('dl-error-msg').textContent = msg;
  }

  // ── STEP 1: Fetch file metadata from server ────────────────────────────
  let metaResponse;
  try {
    metaResponse = await fetch(`${API_BASE}/api/file/${fileId}/meta`);
  } catch {
    showError('Connection error', 'Could not reach the server. Please check your connection.');
    return;
  }

  if (metaResponse.status === 404) {
    showError('File not found', 'This link is invalid or the file has already been deleted.');
    return;
  }
  if (metaResponse.status === 410) {
    const { error } = await metaResponse.json();
    if (error === 'expired') {
      showError('Link expired', 'This file has expired and been automatically deleted.');
    } else {
      showError('Download limit reached', 'The maximum number of downloads for this file has been reached.');
    }
    return;
  }
  if (!metaResponse.ok) {
    showError('Error', 'Something went wrong. Please try again.');
    return;
  }

  const metaData = await metaResponse.json();

  // ── STEP 2: Show the download UI ──────────────────────────────────────
  hide(dlLoading);
  show(dlReady);

  // File size (known from server without decrypting)
  document.getElementById('dl-filesize').textContent = formatSize(metaData.fileSize);

  // Expiry and downloads remaining badges
  // Use a live countdown timer that updates every second
  const expiryBadge = document.getElementById('dl-expiry-info');
  expiryBadge.textContent = formatCountdown(metaData.expiresAt);

  // Start live countdown — updates every second
  const countdownInterval = setInterval(() => {
    const text = formatCountdown(metaData.expiresAt);
    expiryBadge.textContent = text;
    if (text === 'Expired') {
      clearInterval(countdownInterval);
      // Show the expired error state
      showError('Link expired', 'This file has expired and been automatically deleted.');
    }
  }, 1000);

  document.getElementById('dl-downloads-info').textContent =
    metaData.downloadsRemaining === null
      ? '∞ unlimited downloads'
      : `${metaData.downloadsRemaining} download${metaData.downloadsRemaining !== 1 ? 's' : ''} remaining`;

  // Show password field if needed
  if (passwordProtected) {
    show(dlPasswordSection);
  }

  // ── Try to decrypt metadata to get the filename ────────────────────────
  // Without password we can do this immediately. With password, wait until after entry.
  let fileKey = null;
  if (!passwordProtected && metaData.encryptedMeta) {
    try {
      const rawKey = await SecureCrypto.importKeyFromBase64(keyB64);
      const meta = await SecureCrypto.decryptMeta(rawKey, metaData.encryptedMeta);
      document.getElementById('dl-filename').textContent = meta.name;
      fileKey = rawKey; // reuse for actual download
    } catch {
      document.getElementById('dl-filename').textContent = 'Encrypted file';
    }
  }

  // ── Download button click ──────────────────────────────────────────────
  dlBtn.addEventListener('click', async () => {
    if (isLockedOut) return;
    dlBtn.disabled = true;
    show(dlProgressArea);

    try {
      // ── STEP 3: Resolve the decryption key ────────────────────────────
      if (passwordProtected) {
        const password = document.getElementById('dl-password-input').value;
        if (!password) {
          alert('Please enter the password for this file.');
          dlBtn.disabled = false;
          hide(dlProgressArea);
          return;
        }
        setProgress(dlProgressBar, dlProgressLabel, dlProgressPct, 10, 'Deriving key from password…');
        try {
          fileKey = await SecureCrypto.unwrapKeyWithPassword(keyB64, password);
        } catch {
          // ── Wrong password: report failed attempt to server ────────────
          // The server counts attempts and deletes the file after MAX_ATTEMPTS.
          // We never send the actual password — just notify that an attempt failed.
          failedAttempts++;
          hide(dlProgressArea);
          dlBtn.disabled = false;

          try {
            const attemptRes = await fetch(`${API_BASE}/api/file/${fileId}/attempt`, { method: 'POST' });
            if (attemptRes.status === 410) {
              // Server has locked the file
              isLockedOut = true;
              showError('Too many failed attempts', 'This link has been permanently disabled after too many wrong password attempts.');
              return;
            }
            const { attemptsRemaining } = await attemptRes.json().catch(() => ({ attemptsRemaining: MAX_ATTEMPTS - failedAttempts }));
            // Show inline error (not an alert) with remaining count
            show(dlPwError);
            dlPwErrorText.textContent = 'Wrong password.';
            dlPwAttempts.textContent = `${attemptsRemaining} attempt${attemptsRemaining !== 1 ? 's' : ''} remaining before this link is permanently disabled.`;
          } catch {
            // If we can't reach server, just show local count
            show(dlPwError);
            dlPwErrorText.textContent = 'Wrong password.';
            const rem = MAX_ATTEMPTS - failedAttempts;
            dlPwAttempts.textContent = rem > 0 ? `${rem} attempt${rem !== 1 ? 's' : ''} remaining.` : '';
          }

          // Client-side lockout too (belt and suspenders)
          if (failedAttempts >= MAX_ATTEMPTS) {
            isLockedOut = true;
            showError('Too many failed attempts', 'This link has been permanently disabled.');
          }
          return;
        }
        // Password correct — clear error state
        hide(dlPwError);
        dlPwAttempts.textContent = '';
      } else if (!fileKey) {
        setProgress(dlProgressBar, dlProgressLabel, dlProgressPct, 10, 'Importing key…');
        fileKey = await SecureCrypto.importKeyFromBase64(keyB64);
      }

      // ── STEP 4: Download the encrypted blob from the server ────────────
      setProgress(dlProgressBar, dlProgressLabel, dlProgressPct, 25, 'Downloading encrypted file…');
      dlProgressSub.textContent = 'Fetching ciphertext from server…';

      const fileResponse = await fetch(`${API_BASE}/api/file/${fileId}`);

      if (fileResponse.status === 410) {
        const { error } = await fileResponse.json();
        hide(dlProgressArea);
        showError(
          error === 'expired' ? 'Link expired' : 'Download limit reached',
          error === 'expired'
            ? 'This file has expired.'
            : 'This link has reached its download limit.'
        );
        return;
      }
      if (!fileResponse.ok) {
        throw new Error(`Server returned ${fileResponse.status}`);
      }

      // Read the response as ArrayBuffer (raw encrypted bytes)
      const encryptedBuffer = await fileResponse.arrayBuffer();
      setProgress(dlProgressBar, dlProgressLabel, dlProgressPct, 65, 'Decrypting…');
      dlProgressSub.textContent = 'Decryption happening in your browser…';

      // ── STEP 5: Decrypt the file ────────────────────────────────────────
      // AES-GCM decrypt: splits off IV (first 12 bytes) then decrypts the rest.
      // Throws if key is wrong OR data was tampered with (GCM auth tag fails).
      let plaintext;
      try {
        plaintext = await SecureCrypto.decryptFile(fileKey, encryptedBuffer);
      } catch {
        hide(dlProgressArea);
        dlBtn.disabled = false;
        alert('Decryption failed. The key may be incorrect, or the file may be corrupted.');
        return;
      }

      // ── STEP 6: Decrypt metadata to get original filename ──────────────
      setProgress(dlProgressBar, dlProgressLabel, dlProgressPct, 85, 'Recovering file info…');
      let filename = 'securedrop-file';
      let mimeType = 'application/octet-stream';
      if (metaData.encryptedMeta) {
        try {
          const meta = await SecureCrypto.decryptMeta(fileKey, metaData.encryptedMeta);
          filename = meta.name;
          mimeType = meta.type;
        } catch { /* use fallback name */ }
      }

      // ── STEP 7: Trigger browser download ──────────────────────────────
      // Create a temporary Blob URL and click it — decrypted bytes never go back to the network.
      setProgress(dlProgressBar, dlProgressLabel, dlProgressPct, 100, 'Done!');
      dlProgressSub.textContent = 'Your file is ready.';

      const blob = new Blob([plaintext], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

      // Update remaining downloads badge
      const remaining = metaData.downloadsRemaining;
      if (remaining !== null) {
        const newRemaining = remaining - 1;
        document.getElementById('dl-downloads-info').textContent =
          newRemaining <= 0
            ? 'No downloads remaining — link is now expired'
            : `${newRemaining} download${newRemaining !== 1 ? 's' : ''} remaining`;
      }

      // Show success state on button
      dlBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Downloaded
      `;

    } catch (err) {
      console.error('Download error:', err);
      hide(dlProgressArea);
      dlBtn.disabled = false;
      alert(`Error: ${err.message}`);
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
// Orchestration order:
//  1. Preloader runs immediately (black screen → fills bar → slides away)
//  2. On preloader complete: start animations (Lenis + ScrollTrigger)
//  3. Then: init cursor, magnetic buttons, particles, grain, hero text-split
//  4. Then: route page (upload or download) and bind all UI logic

document.addEventListener('DOMContentLoaded', () => {

  // ── Register GSAP ScrollTrigger plugin ─────────────────────────────────
  // Must be done before any ScrollTrigger usage
  if (typeof ScrollTrigger !== 'undefined') {
    gsap.registerPlugin(ScrollTrigger);
  }

  // ── Run preloader, then bootstrap everything else ───────────────────────
  if (typeof runPreloader === 'function') {
    runPreloader(() => {
      // Preloader done — init all motion systems
      if (typeof initAnimations === 'function') initAnimations();
      if (typeof initHeroTextSplit === 'function') initHeroTextSplit();
      if (typeof initTearTransitions === 'function') initTearTransitions();
      if (typeof initCursor === 'function') initCursor();
      if (typeof initMagneticButtons === 'function') initMagneticButtons('.magnetic', 0.28);
      if (typeof initParticles === 'function') initParticles();
      if (typeof initFilmGrain === 'function') initFilmGrain();

      // Route and init page
      routePage();
      initFaqAccordion();
      // Scroll animations already handled by animations.js via ScrollTrigger
    });
  } else {
    // Fallback if preloader.js failed to load
    routePage();
    initFaqAccordion();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Show a toast notification in the top-right corner.
 * Types: 'success' | 'warn' | 'error'
 * Auto-dismisses after `duration` ms.
 *
 * Usage: showToast('Link copied!', 'success');
 */
function showToast(message, type = 'success', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = {
    success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><polyline points="20 6 9 17 4 12" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    warn:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    error:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  };

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.success}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);
}

// Make showToast globally accessible (used by copy buttons and other actions)
window.showToast = showToast;

// ══════════════════════════════════════════════════════════════════════════════
// FAQ ACCORDION
// ══════════════════════════════════════════════════════════════════════════════

function initFaqAccordion() {
  const items = document.querySelectorAll('.faq-item');
  items.forEach(item => {
    const btn    = item.querySelector('.faq-question');
    const answer = item.querySelector('.faq-answer');
    if (!btn || !answer) return;

    btn.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      // Close all others
      items.forEach(i => {
        i.classList.remove('open');
        const q = i.querySelector('.faq-question');
        if (q) q.setAttribute('aria-expanded', 'false');
      });
      // Toggle this one
      if (!isOpen) {
        item.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SCROLL-TRIGGERED ENTRANCE ANIMATIONS (Intersection Observer)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Elements with class .animate-fadein that are below the fold
 * get paused until they scroll into view, then play their animation.
 * This makes the "How it works" and FAQ sections animate in as the user scrolls.
 */
function initScrollAnimations() {
  const elements = document.querySelectorAll('.animate-fadein');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.animationPlayState = 'running';
        observer.unobserve(entry.target); // fire once
      }
    });
  }, { threshold: 0.1 });

  elements.forEach(el => {
    // Pause immediately, let IO resume it
    el.style.animationPlayState = 'paused';
    observer.observe(el);
  });
}
