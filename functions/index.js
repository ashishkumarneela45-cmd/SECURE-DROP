/**
 * SecureDrop - Firebase Cloud Function Backend
 *
 * This is the Firebase-ready version of the original Express server.
 * Two things changed from the local version:
 *
 *  1. File storage: local disk (uploads/*.bin) -> Firebase Storage
 *  2. Metadata registry: in-memory Map -> Firestore
 *     (Cloud Functions are stateless - an in-memory Map would randomly
 *      lose data whenever a new function instance spins up)
 *
 * Everything else - the zero-knowledge design, the route logic, the
 * expiry/download-limit/password-attempt rules - stays the same.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
const FILES_COLLECTION = 'files';
const MAX_FAILED_ATTEMPTS = 5;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({ origin: true }));
app.use(express.json());

// multer now stores the upload in memory (req.file.buffer) instead of on disk,
// since Cloud Functions don't have a persistent local filesystem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max upload size
});

// ── Routes ────────────────────────────────────────────────────────────────────
// Note: routes here ARE prefixed with /api. Firebase Hosting forwards the
// FULL matched path to the function (it does not strip the /api prefix),
// so these routes must include it to match what the frontend calls
// (e.g. fetch('/api/upload')).

/**
 * POST /api/upload
 * Same contract as before: encryptedFile (multipart) + expirySeconds +
 * maxDownloads + burnAfterRead + encryptedMeta. Returns { id }.
 */
app.post('/api/upload', upload.single('encryptedFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file received.' });
    }

    const {
      expirySeconds = 3600,
      maxDownloads = 1,
      burnAfterRead = 'false',
      encryptedMeta = '',
    } = req.body;

    const fileId = uuidv4();
    const now = Date.now();
    const expiresAt = now + parseInt(expirySeconds, 10) * 1000;
    const maxDL = parseInt(maxDownloads, 10); // 0 = unlimited
    const burn = burnAfterRead === 'true';

    // Upload the encrypted blob straight from memory to Firebase Storage
    const storagePath = `uploads/${fileId}.bin`;
    await bucket.file(storagePath).save(req.file.buffer, {
      contentType: 'application/octet-stream',
      resumable: false,
    });

    // Store the file's "registry entry" as a Firestore document instead of a Map entry
    await db.collection(FILES_COLLECTION).doc(fileId).set({
      expiresAt,
      maxDownloads: burn ? 1 : maxDL,
      downloadCount: 0,
      fileSize: req.file.size,
      createdAt: now,
      failedAttempts: 0,
      encryptedMeta: encryptedMeta || null,
      storagePath,
    });

    console.log(`[upload] Registered ${fileId} | expires: ${new Date(expiresAt).toISOString()} | maxDL: ${burn ? 1 : maxDL}`);

    res.json({ id: fileId });
  } catch (err) {
    console.error('[upload] Error:', err);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

/**
 * GET /file/:id/meta
 * Returns encrypted metadata + link status, same as before.
 */
app.get('/api/file/:id/meta', async (req, res) => {
  const { id } = req.params;
  const docRef = db.collection(FILES_COLLECTION).doc(id);

  try {
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'not_found', message: 'File not found or already deleted.' });
    }
    const entry = doc.data();

    if (Date.now() > entry.expiresAt) {
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'expired', message: 'This link has expired.' });
    }

    if (entry.maxDownloads > 0 && entry.downloadCount >= entry.maxDownloads) {
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'download_limit', message: 'Maximum downloads reached. This link is no longer valid.' });
    }

    const downloadsRemaining = entry.maxDownloads === 0
      ? null
      : entry.maxDownloads - entry.downloadCount;

    res.json({
      encryptedMeta: entry.encryptedMeta,
      fileSize: entry.fileSize,
      expiresAt: entry.expiresAt,
      downloadsRemaining,
    });
  } catch (err) {
    console.error('[meta] Error:', err);
    res.status(500).json({ error: 'Failed to fetch file info.' });
  }
});

/**
 * POST /file/:id/attempt
 * Tracks failed password attempts, same 5-strike lockout as before.
 * Failed-attempt count now lives in Firestore instead of the in-memory entry.
 */
app.post('/api/file/:id/attempt', async (req, res) => {
  const { id } = req.params;
  const docRef = db.collection(FILES_COLLECTION).doc(id);

  try {
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'not_found' });
    }
    const entry = doc.data();
    const failedAttempts = (entry.failedAttempts || 0) + 1;

    console.log(`[attempt] ${id} — failed attempt #${failedAttempts}/${MAX_FAILED_ATTEMPTS}`);

    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      console.log(`[lockout] Deleting ${id} — too many failed password attempts.`);
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'locked', message: 'Too many failed attempts. This link has been permanently disabled.' });
    }

    await docRef.update({ failedAttempts });
    res.json({ attemptsRemaining: MAX_FAILED_ATTEMPTS - failedAttempts });
  } catch (err) {
    console.error('[attempt] Error:', err);
    res.status(500).json({ error: 'Failed to record attempt.' });
  }
});

/**
 * GET /file/:id
 * Streams the encrypted blob from Firebase Storage, same expiry/limit checks,
 * increments the counter before streaming to avoid race conditions.
 */
app.get('/api/file/:id', async (req, res) => {
  const { id } = req.params;
  const docRef = db.collection(FILES_COLLECTION).doc(id);

  try {
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'not_found', message: 'File not found or already deleted.' });
    }
    const entry = doc.data();

    if (Date.now() > entry.expiresAt) {
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'expired', message: 'This link has expired.' });
    }

    if (entry.maxDownloads > 0 && entry.downloadCount >= entry.maxDownloads) {
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'download_limit', message: 'Maximum downloads reached.' });
    }

    const file = bucket.file(entry.storagePath);
    const [exists] = await file.exists();
    if (!exists) {
      await docRef.delete();
      return res.status(404).json({ error: 'not_found', message: 'File data missing.' });
    }

    // Increment BEFORE streaming (same reasoning as the original: prevents
    // a race where two downloads both slip in under the limit)
    const newCount = entry.downloadCount + 1;
    await docRef.update({ downloadCount: newCount });
    console.log(`[download] ${id} | download #${newCount}/${entry.maxDownloads || '∞'}`);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', entry.fileSize);

    const stream = file.createReadStream();
    stream.pipe(res);

    stream.on('end', async () => {
      if (entry.maxDownloads > 0 && newCount >= entry.maxDownloads) {
        console.log(`[cleanup] Deleting ${id} - download limit reached.`);
        await deleteFile(id, entry);
      }
    });

    stream.on('error', (err) => {
      console.error('[download] Stream error:', err);
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    console.error('[download] Error:', err);
    res.status(500).json({ error: 'Download failed.' });
  }
});

// ── Cleanup helpers ───────────────────────────────────────────────────────────

/**
 * Deletes a file's Storage blob and its Firestore registry entry.
 */
async function deleteFile(id, entry) {
  try {
    if (entry && entry.storagePath) {
      await bucket.file(entry.storagePath).delete({ ignoreNotFound: true });
    }
    await db.collection(FILES_COLLECTION).doc(id).delete();
  } catch (err) {
    console.error(`[cleanup] Failed to delete ${id}:`, err);
  }
}

/**
 * Scheduled cleanup - replaces the old setInterval() approach, which can't
 * run inside a stateless Cloud Function. This runs as its own separate
 * function on a Cloud Scheduler timer (needs the Blaze plan, which you're
 * already on) and removes any expired files that were never downloaded.
 */
exports.scheduledCleanup = functions.pubsub.schedule('every 15 minutes').onRun(async () => {
  const now = Date.now();
  const snapshot = await db.collection(FILES_COLLECTION).where('expiresAt', '<', now).get();

  let removed = 0;
  for (const doc of snapshot.docs) {
    await deleteFile(doc.id, doc.data());
    removed++;
  }

  console.log(`[scheduledCleanup] Removed ${removed} expired file(s).`);
  return null;
});

// ── Main API function ─────────────────────────────────────────────────────────
// This exposes your whole Express app as one Cloud Function called "api".
// Firebase Hosting will route /api/** requests to it (see firebase.json).
exports.api = functions.https.onRequest(app);
