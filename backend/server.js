/**
 * SecureDrop - Backend Server
 *
 * IMPORTANT: This server is "zero-knowledge" by design.
 * - It only ever receives and stores ALREADY-ENCRYPTED file blobs.
 * - The encryption key is NEVER sent here - it lives only in the URL fragment (#key)
 *   which browsers do not include in HTTP requests.
 * - File metadata (original name, type) is also encrypted client-side.
 * - No user accounts, no logging of file contents.
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// Directory where encrypted blobs are stored on disk
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// In-memory store for file metadata.
// Each entry: { id, expiresAt, maxDownloads, downloadCount, encryptedMetaSize, totalSize }
// Note: encryptedMetadata (original filename, type) is stored alongside the blob on disk.
const fileRegistry = new Map();

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({
  origin: '*', // In production, restrict this to your frontend domain
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// Serve the frontend's built files (index.html, etc.) from ../frontend/src
app.use(express.static(path.join(__dirname, '..', 'frontend', 'src')));

// ── Multer storage config ─────────────────────────────────────────────────────
// multer handles multipart/form-data (file uploads).
// We store the raw bytes on disk; they are already encrypted by the browser.

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    // Use a random UUID as the filename - no original name on disk
    cb(null, uuidv4() + '.bin');
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max upload size
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/upload
 *
 * Accepts an encrypted file blob plus settings:
 *   - encryptedFile: the binary ciphertext (multipart field)
 *   - encryptedMeta: JSON string encrypted client-side (contains original filename + type)
 *   - expirySeconds: number of seconds before the link expires
 *   - maxDownloads:  max number of downloads allowed (0 = unlimited)
 *   - burnAfterRead: boolean - delete after first download, overrides maxDownloads
 *
 * Returns: { id: "<uuid>" } — the client builds the full share URL from this
 */
app.post('/api/upload', upload.single('encryptedFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file received.' });
    }

    const {
      expirySeconds = 3600,  // default: 1 hour
      maxDownloads = 1,       // default: 1 download
      burnAfterRead = 'false',
      encryptedMeta = '',     // base64-encoded encrypted metadata (filename, type)
    } = req.body;

    // Generate a unique ID for this file share
    const fileId = uuidv4();
    const now = Date.now();
    const expiresAt = now + parseInt(expirySeconds, 10) * 1000;
    const maxDL = parseInt(maxDownloads, 10); // 0 = unlimited
    const burn = burnAfterRead === 'true';

    // Rename the temp multer file to match our chosen fileId
    const oldPath = req.file.path;
    const newPath = path.join(UPLOADS_DIR, fileId + '.bin');
    fs.renameSync(oldPath, newPath);

    // Store encrypted metadata separately (original filename + MIME type, encrypted)
    if (encryptedMeta) {
      fs.writeFileSync(path.join(UPLOADS_DIR, fileId + '.meta'), encryptedMeta, 'utf8');
    }

    // Register the file
    fileRegistry.set(fileId, {
      id: fileId,
      expiresAt,
      maxDownloads: burn ? 1 : maxDL,  // burn = force max 1
      downloadCount: 0,
      fileSize: req.file.size,
      createdAt: now,
    });

    console.log(`[upload] New file registered: ${fileId} | expires: ${new Date(expiresAt).toISOString()} | maxDL: ${burn ? 1 : maxDL}`);

    res.json({ id: fileId });
  } catch (err) {
    console.error('[upload] Error:', err.message);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

/**
 * GET /api/file/:id/meta
 *
 * Returns encrypted metadata for a file (so the download page can display
 * file name and size before the user clicks "Decrypt & Download").
 * Also returns link status (valid, expiry info, downloads remaining).
 *
 * The metadata itself is encrypted — the server cannot read the filename.
 */
app.get('/api/file/:id/meta', (req, res) => {
  const { id } = req.params;
  const entry = fileRegistry.get(id);

  if (!entry) {
    return res.status(404).json({ error: 'not_found', message: 'File not found or already deleted.' });
  }

  // Check expiry
  if (Date.now() > entry.expiresAt) {
    deleteFile(id);
    return res.status(410).json({ error: 'expired', message: 'This link has expired.' });
  }

  // Check download limit
  if (entry.maxDownloads > 0 && entry.downloadCount >= entry.maxDownloads) {
    deleteFile(id);
    return res.status(410).json({ error: 'download_limit', message: 'Maximum downloads reached. This link is no longer valid.' });
  }

  // Read encrypted metadata if available
  const metaPath = path.join(UPLOADS_DIR, id + '.meta');
  let encryptedMeta = null;
  if (fs.existsSync(metaPath)) {
    encryptedMeta = fs.readFileSync(metaPath, 'utf8');
  }

  const downloadsRemaining = entry.maxDownloads === 0
    ? null  // unlimited
    : entry.maxDownloads - entry.downloadCount;

  res.json({
    encryptedMeta,
    fileSize: entry.fileSize,
    expiresAt: entry.expiresAt,
    downloadsRemaining,
  });
});

/**
 * POST /api/file/:id/attempt
 *
 * Called by the download page when a password attempt fails (wrong password).
 * Tracks failed attempts per file. After MAX_ATTEMPTS, the file is deleted
 * and the link is permanently disabled.
 *
 * This happens CLIENT-SIDE: the browser attempts to decrypt with the entered
 * password and calls this endpoint only when decryption fails. The actual
 * password is never sent here — we just count the attempts.
 *
 * Returns: { attemptsRemaining: N } or { error: 'locked' } when limit hit.
 */
const MAX_FAILED_ATTEMPTS = 5;

app.post('/api/file/:id/attempt', (req, res) => {
  const { id } = req.params;
  const entry = fileRegistry.get(id);

  if (!entry) {
    return res.status(404).json({ error: 'not_found' });
  }

  // Initialize attempt counter if not present
  if (typeof entry.failedAttempts !== 'number') {
    entry.failedAttempts = 0;
  }

  entry.failedAttempts++;
  console.log(`[attempt] ${id} — failed attempt #${entry.failedAttempts}/${MAX_FAILED_ATTEMPTS}`);

  if (entry.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    console.log(`[lockout] Deleting ${id} — too many failed password attempts.`);
    deleteFile(id);
    return res.status(410).json({ error: 'locked', message: 'Too many failed attempts. This link has been permanently disabled.' });
  }

  const attemptsRemaining = MAX_FAILED_ATTEMPTS - entry.failedAttempts;
  res.json({ attemptsRemaining });
});

/**
 * GET /api/file/:id
 *
 * Streams the encrypted file blob to the client.
 * Increments the download counter and deletes if limit is reached.
 *
 * The client will decrypt the blob locally using the key from the URL fragment.
 */
app.get('/api/file/:id', (req, res) => {
  const { id } = req.params;
  const entry = fileRegistry.get(id);

  if (!entry) {
    return res.status(404).json({ error: 'not_found', message: 'File not found or already deleted.' });
  }

  // Check expiry
  if (Date.now() > entry.expiresAt) {
    deleteFile(id);
    return res.status(410).json({ error: 'expired', message: 'This link has expired.' });
  }

  // Check download limit
  if (entry.maxDownloads > 0 && entry.downloadCount >= entry.maxDownloads) {
    deleteFile(id);
    return res.status(410).json({ error: 'download_limit', message: 'Maximum downloads reached.' });
  }

  const filePath = path.join(UPLOADS_DIR, id + '.bin');
  if (!fs.existsSync(filePath)) {
    fileRegistry.delete(id);
    return res.status(404).json({ error: 'not_found', message: 'File data missing.' });
  }

  // Increment download counter BEFORE streaming (prevents race conditions on burn-after-read)
  entry.downloadCount++;
  console.log(`[download] ${id} | download #${entry.downloadCount}/${entry.maxDownloads || '∞'}`);

  // Stream the encrypted blob
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', entry.fileSize);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  // After streaming, delete if we've hit the limit
  stream.on('end', () => {
    if (entry.maxDownloads > 0 && entry.downloadCount >= entry.maxDownloads) {
      console.log(`[cleanup] Deleting ${id} - download limit reached.`);
      deleteFile(id);
    }
  });
});

// ── Cleanup helpers ───────────────────────────────────────────────────────────

/**
 * Deletes a file's blob, metadata, and registry entry.
 */
function deleteFile(id) {
  const binPath = path.join(UPLOADS_DIR, id + '.bin');
  const metaPath = path.join(UPLOADS_DIR, id + '.meta');

  if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  fileRegistry.delete(id);
}

/**
 * Scheduled cleanup: runs every 5 minutes, removes all expired files.
 * This catches files that expired but were never downloaded.
 */
function runCleanup() {
  const now = Date.now();
  let removed = 0;
  for (const [id, entry] of fileRegistry.entries()) {
    if (now > entry.expiresAt) {
      deleteFile(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} expired file(s).`);
  }
}

// Run cleanup every 5 minutes
setInterval(runCleanup, 5 * 60 * 1000);

// Also run once at startup to clean up any leftover .bin/.meta files
// from a previous server run (registry is in-memory, so it's empty on restart)
function cleanupOrphanedFiles() {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const files = fs.readdirSync(UPLOADS_DIR);
  let removed = 0;
  for (const file of files) {
    // Any file left over from a previous run is not in our registry -> delete it
    const id = file.replace(/\.(bin|meta)$/, '');
    if (!fileRegistry.has(id)) {
      fs.unlinkSync(path.join(UPLOADS_DIR, file));
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[startup] Cleaned up ${removed} orphaned file(s) from previous run.`);
  }
}

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  cleanupOrphanedFiles();
  console.log(`SecureDrop backend running on http://localhost:${PORT}`);
  console.log(`Serving frontend from: ${path.join(__dirname, '..', 'frontend', 'src')}`);
});
