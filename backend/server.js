/**
 * SecureDrop - Backend Server (Render + Supabase version)
 *
 * This runs as a standard standalone Express server on Render (free tier,
 * no card needed) instead of a Firebase Cloud Function. Storage and
 * metadata both live in Supabase (also free, no card needed):
 *
 *   - Encrypted file blobs -> Supabase Storage (a bucket called "uploads")
 *   - Metadata / registry entries -> Supabase Postgres (a table called "files")
 *
 * The zero-knowledge design is unchanged: this server only ever sees
 * already-encrypted bytes. The decryption key never reaches it.
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Supabase client ───────────────────────────────────────────────────────────
// SUPABASE_URL and SUPABASE_KEY are set as environment variables on Render -
// never hardcode them here, and never commit them to GitHub.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const BUCKET = 'uploads';
const TABLE = 'files';
const MAX_FAILED_ATTEMPTS = 5;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({
  origin: '*', // frontend is on a different domain (Firebase Hosting), so this must allow it
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// Multer stores the upload in memory (not on Render's disk, which isn't
// reliable long-term on the free tier) - we hand the buffer straight to Supabase.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
});

// ── Routes ────────────────────────────────────────────────────────────────────

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
    const maxDL = parseInt(maxDownloads, 10);
    const burn = burnAfterRead === 'true';
    const storagePath = `${fileId}.bin`;

    // Upload the encrypted blob to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: 'application/octet-stream',
        upsert: false,
      });

    if (uploadError) throw uploadError;

    // Insert the registry entry into the Postgres "files" table
    const { error: dbError } = await supabase.from(TABLE).insert({
      id: fileId,
      expires_at: expiresAt,
      max_downloads: burn ? 1 : maxDL,
      download_count: 0,
      file_size: req.file.size,
      created_at: now,
      failed_attempts: 0,
      encrypted_meta: encryptedMeta || null,
      storage_path: storagePath,
    });

    if (dbError) throw dbError;

    console.log(`[upload] Registered ${fileId} | expires: ${new Date(expiresAt).toISOString()} | maxDL: ${burn ? 1 : maxDL}`);
    res.json({ id: fileId });
  } catch (err) {
    console.error('[upload] Error:', err.message || err);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

/**
 * GET /api/file/:id/meta
 * Returns encrypted metadata + link status.
 */
app.get('/api/file/:id/meta', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: entry, error } = await supabase.from(TABLE).select('*').eq('id', id).single();

    if (error || !entry) {
      return res.status(404).json({ error: 'not_found', message: 'File not found or already deleted.' });
    }

    if (Date.now() > entry.expires_at) {
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'expired', message: 'This link has expired.' });
    }

    if (entry.max_downloads > 0 && entry.download_count >= entry.max_downloads) {
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'download_limit', message: 'Maximum downloads reached. This link is no longer valid.' });
    }

    const downloadsRemaining = entry.max_downloads === 0
      ? null
      : entry.max_downloads - entry.download_count;

    res.json({
      encryptedMeta: entry.encrypted_meta,
      fileSize: entry.file_size,
      expiresAt: entry.expires_at,
      downloadsRemaining,
    });
  } catch (err) {
    console.error('[meta] Error:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch file info.' });
  }
});

/**
 * POST /api/file/:id/attempt
 * Tracks failed password attempts, 5-strike lockout.
 */
app.post('/api/file/:id/attempt', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: entry, error } = await supabase.from(TABLE).select('*').eq('id', id).single();

    if (error || !entry) {
      return res.status(404).json({ error: 'not_found' });
    }

    const failedAttempts = (entry.failed_attempts || 0) + 1;
    console.log(`[attempt] ${id} — failed attempt #${failedAttempts}/${MAX_FAILED_ATTEMPTS}`);

    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      console.log(`[lockout] Deleting ${id} — too many failed password attempts.`);
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'locked', message: 'Too many failed attempts. This link has been permanently disabled.' });
    }

    await supabase.from(TABLE).update({ failed_attempts: failedAttempts }).eq('id', id);
    res.json({ attemptsRemaining: MAX_FAILED_ATTEMPTS - failedAttempts });
  } catch (err) {
    console.error('[attempt] Error:', err.message || err);
    res.status(500).json({ error: 'Failed to record attempt.' });
  }
});

/**
 * GET /api/file/:id
 * Streams the encrypted blob from Supabase Storage, same checks as before.
 */
app.get('/api/file/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: entry, error } = await supabase.from(TABLE).select('*').eq('id', id).single();

    if (error || !entry) {
      return res.status(404).json({ error: 'not_found', message: 'File not found or already deleted.' });
    }

    if (Date.now() > entry.expires_at) {
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'expired', message: 'This link has expired.' });
    }

    if (entry.max_downloads > 0 && entry.download_count >= entry.max_downloads) {
      await deleteFile(id, entry);
      return res.status(410).json({ error: 'download_limit', message: 'Maximum downloads reached.' });
    }

    // Download the encrypted blob from Supabase Storage
    const { data: blobData, error: downloadError } = await supabase.storage
      .from(BUCKET)
      .download(entry.storage_path);

    if (downloadError || !blobData) {
      await supabase.from(TABLE).delete().eq('id', id);
      return res.status(404).json({ error: 'not_found', message: 'File data missing.' });
    }

    // Increment BEFORE sending the response (avoids a race on repeated quick requests)
    const newCount = entry.download_count + 1;
    await supabase.from(TABLE).update({ download_count: newCount }).eq('id', id);
    console.log(`[download] ${id} | download #${newCount}/${entry.max_downloads || '∞'}`);

    const buffer = Buffer.from(await blobData.arrayBuffer());
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', entry.file_size);
    res.send(buffer);

    // Clean up after sending if the download limit is now reached
    if (entry.max_downloads > 0 && newCount >= entry.max_downloads) {
      console.log(`[cleanup] Deleting ${id} - download limit reached.`);
      await deleteFile(id, entry);
    }
  } catch (err) {
    console.error('[download] Error:', err.message || err);
    res.status(500).json({ error: 'Download failed.' });
  }
});

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function deleteFile(id, entry) {
  try {
    if (entry && entry.storage_path) {
      await supabase.storage.from(BUCKET).remove([entry.storage_path]);
    }
    await supabase.from(TABLE).delete().eq('id', id);
  } catch (err) {
    console.error(`[cleanup] Failed to delete ${id}:`, err.message || err);
  }
}

/**
 * Scheduled cleanup - runs every 15 minutes on this server's own timer
 * (this works fine here since Render keeps one long-running process,
 * unlike stateless Cloud Functions).
 */
async function runCleanup() {
  try {
    const now = Date.now();
    const { data: expired, error } = await supabase.from(TABLE).select('*').lt('expires_at', now);
    if (error) throw error;

    for (const entry of expired || []) {
      await deleteFile(entry.id, entry);
    }
    if (expired && expired.length > 0) {
      console.log(`[cleanup] Removed ${expired.length} expired file(s).`);
    }
  } catch (err) {
    console.error('[cleanup] Error:', err.message || err);
  }
}

setInterval(runCleanup, 5 * 60 * 1000);

// ── Health check (useful for Render + uptime checks) ───────────────────────────
app.get('/', (req, res) => {
  res.send('SecureDrop backend is running.');
});

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  runCleanup(); // clean up any expired entries on startup too
  console.log(`SecureDrop backend running on port ${PORT}`);
});
