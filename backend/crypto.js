/**
 * crypto.js — SecureDrop client-side encryption module
 *
 * ═══════════════════════════════════════════════════════════
 * HOW THE ENCRYPTION FLOW WORKS (beginner-friendly summary)
 * ═══════════════════════════════════════════════════════════
 *
 * UPLOADING:
 *  1. Browser generates a random 256-bit AES key.
 *     (AES-GCM is symmetric encryption: same key encrypts and decrypts)
 *  2. We also generate a random 96-bit IV (Initialization Vector).
 *     The IV is like a random salt — it ensures two encryptions of the
 *     same file produce different ciphertext each time. Not secret.
 *  3. We encrypt the file bytes: ciphertext = AES_GCM_Encrypt(key, IV, plaintext)
 *  4. The encrypted blob we upload to the server = [IV bytes] + [ciphertext bytes]
 *     Prepending the IV lets the recipient recover it without it being secret.
 *  5. The key is BASE64URL-encoded and placed after the # in the share URL.
 *     Because the # fragment is NEVER sent to the server by the browser,
 *     the server literally cannot know the key.
 *
 * DOWNLOADING:
 *  1. Browser reads the key from window.location.hash.
 *  2. Downloads the encrypted blob from the server.
 *  3. Splits out the IV (first 12 bytes) and the ciphertext (rest).
 *  4. Decrypts: plaintext = AES_GCM_Decrypt(key, IV, ciphertext)
 *  5. Serves the decrypted file to the user via a Blob URL.
 *
 * OPTIONAL PASSWORD PROTECTION:
 *  If the user sets a password, we derive a second key from that password
 *  using PBKDF2 (a slow hash that resists brute-force) and re-encrypt the
 *  file key itself. The encrypted key wrapper travels in the URL fragment too.
 *  On download, the user types the password, we derive the same PBKDF2 key,
 *  unwrap the file key, then decrypt the file.
 *
 * All of this uses the browser's built-in Web Crypto API — no third-party
 * crypto library needed. Web Crypto is fast (hardware-accelerated) and
 * has been audited and standardized.
 * ═══════════════════════════════════════════════════════════
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const AES_KEY_LENGTH = 256;          // bits — AES-256
const GCM_IV_LENGTH = 12;            // bytes — standard for AES-GCM
const PBKDF2_ITERATIONS = 200_000;   // iterations for password derivation (slow = more secure)
const PBKDF2_SALT_LENGTH = 16;       // bytes

// ── Key generation ────────────────────────────────────────────────────────────

/**
 * Generates a fresh random AES-256-GCM key.
 * This key will encrypt/decrypt the file. It is only ever stored in the URL fragment.
 *
 * @returns {Promise<CryptoKey>}
 */
async function generateFileKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    true,  // extractable = true so we can export it to put in the URL
    ['encrypt', 'decrypt']
  );
}

/**
 * Exports a CryptoKey to raw bytes and returns a URL-safe base64 string.
 * This is the string that goes into the URL fragment.
 *
 * @param {CryptoKey} key
 * @returns {Promise<string>} base64url-encoded key
 */
async function exportKeyToBase64(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64url(raw);
}

/**
 * Imports a base64url-encoded key string back into a CryptoKey.
 *
 * @param {string} base64url
 * @returns {Promise<CryptoKey>}
 */
async function importKeyFromBase64(base64url) {
  const raw = base64urlToArrayBuffer(base64url);
  return crypto.subtle.importKey(
    'raw', raw,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,  // not extractable once imported for decryption
    ['decrypt']
  );
}

// ── File encryption ───────────────────────────────────────────────────────────

/**
 * Encrypts an ArrayBuffer using AES-256-GCM.
 *
 * Layout of the returned buffer:
 *   [ 12 bytes IV ][ N bytes ciphertext + 16-byte GCM auth tag ]
 *
 * The IV is prepended to the ciphertext so the downloader can recover it
 * without it needing to be secret (IVs just need to be unique, not secret).
 *
 * @param {CryptoKey} key    - AES-GCM key
 * @param {ArrayBuffer} data - plaintext file bytes
 * @returns {Promise<ArrayBuffer>}  IV + ciphertext
 */
async function encryptFile(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  // Concatenate IV + ciphertext into a single buffer
  const result = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.byteLength);
  return result.buffer;
}

/**
 * Decrypts an ArrayBuffer produced by encryptFile().
 * Splits off the first 12 bytes as the IV, decrypts the rest.
 *
 * @param {CryptoKey} key           - AES-GCM key
 * @param {ArrayBuffer} encryptedData  - IV + ciphertext (as stored on server)
 * @returns {Promise<ArrayBuffer>}  plaintext file bytes
 */
async function decryptFile(key, encryptedData) {
  const bytes = new Uint8Array(encryptedData);

  // Split IV from ciphertext
  const iv = bytes.slice(0, GCM_IV_LENGTH);
  const ciphertext = bytes.slice(GCM_IV_LENGTH);

  // Decrypt — throws if the key is wrong or data was tampered with (GCM auth tag fails)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return plaintext;
}

// ── Metadata encryption ───────────────────────────────────────────────────────

/**
 * Encrypts file metadata (name, type) using the same file key.
 * This means the server cannot even know the original filename.
 *
 * @param {CryptoKey} key
 * @param {object} meta  - { name: string, type: string }
 * @returns {Promise<string>}  base64-encoded encrypted metadata
 */
async function encryptMeta(key, meta) {
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(JSON.stringify(meta));
  const encrypted = await encryptFile(key, plaintext.buffer);
  return arrayBufferToBase64url(encrypted);
}

/**
 * Decrypts file metadata that was encrypted with encryptMeta().
 *
 * @param {CryptoKey} key
 * @param {string} base64Meta  - base64-encoded encrypted metadata
 * @returns {Promise<{ name: string, type: string }>}
 */
async function decryptMeta(key, base64Meta) {
  const encrypted = base64urlToArrayBuffer(base64Meta);
  const plaintext = await decryptFile(key, encrypted);
  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(plaintext));
}

// ── Password-based key wrapping ───────────────────────────────────────────────

/**
 * Derives a wrapping key from a password using PBKDF2.
 * PBKDF2 is intentionally slow (200k iterations) to resist brute-force attacks.
 *
 * @param {string} password
 * @param {Uint8Array} salt  - random bytes, stored alongside the wrapped key
 * @returns {Promise<CryptoKey>}  a key suitable for AES-KW (key wrapping)
 */
async function deriveKeyFromPassword(password, salt) {
  const encoder = new TextEncoder();

  // Import the password as a base key material for PBKDF2
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive an AES-KW key (Key Wrap — designed specifically for wrapping other keys)
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Wraps (encrypts) the file key with a password-derived key.
 * Returns a base64url string containing: [16-byte salt][wrapped key bytes]
 *
 * @param {CryptoKey} fileKey   - the AES-256-GCM file key
 * @param {string} password
 * @returns {Promise<string>}  base64url( salt + wrapped key )
 */
async function wrapKeyWithPassword(fileKey, password) {
  // Make the key extractable so we can wrap it
  const exportableKey = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.exportKey('raw', fileKey),
    { name: 'AES-GCM', length: 256 },
    true,  // extractable
    ['encrypt', 'decrypt']
  );

  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));
  const wrappingKey = await deriveKeyFromPassword(password, salt);

  const wrappedKey = await crypto.subtle.wrapKey('raw', exportableKey, wrappingKey, 'AES-KW');

  // Prepend salt to wrapped key
  const result = new Uint8Array(salt.byteLength + wrappedKey.byteLength);
  result.set(salt, 0);
  result.set(new Uint8Array(wrappedKey), salt.byteLength);
  return arrayBufferToBase64url(result.buffer);
}

/**
 * Unwraps (decrypts) a wrapped file key using the password.
 * The base64url string contains: [16-byte salt][wrapped key bytes]
 *
 * @param {string} wrappedKeyB64  - output of wrapKeyWithPassword()
 * @param {string} password
 * @returns {Promise<CryptoKey>}
 */
async function unwrapKeyWithPassword(wrappedKeyB64, password) {
  const bytes = new Uint8Array(base64urlToArrayBuffer(wrappedKeyB64));

  const salt = bytes.slice(0, PBKDF2_SALT_LENGTH);
  const wrappedKey = bytes.slice(PBKDF2_SALT_LENGTH);

  const wrappingKey = await deriveKeyFromPassword(password, salt);

  return crypto.subtle.unwrapKey(
    'raw',
    wrappedKey,
    wrappingKey,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

// ── URL fragment helpers ──────────────────────────────────────────────────────

/**
 * Builds the URL fragment (the part after #) that encodes all secrets.
 *
 * Without password:
 *   #<fileId>:<base64url_key>
 *
 * With password:
 *   #<fileId>:<base64url_wrapped_key>:pw
 *
 * The fragment is NEVER sent to the server by the browser. The key stays
 * exclusively on the client side.
 *
 * @param {string} fileId
 * @param {string} keyB64     - base64url raw key (no password) or wrapped key (with password)
 * @param {boolean} hasPassword
 * @returns {string}
 */
function buildFragment(fileId, keyB64, hasPassword) {
  const parts = [fileId, keyB64];
  if (hasPassword) parts.push('pw');
  return '#' + parts.join(':');
}

/**
 * Parses the URL fragment into its components.
 *
 * @param {string} fragment  - e.g. "#abc123:keydata:pw" (the # is stripped)
 * @returns {{ fileId: string, keyB64: string, passwordProtected: boolean } | null}
 */
function parseFragment(fragment) {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const parts = raw.split(':');
  if (parts.length < 2) return null;

  return {
    fileId: parts[0],
    keyB64: parts[1],
    passwordProtected: parts[2] === 'pw',
  };
}

// ── Base64URL utilities ───────────────────────────────────────────────────────
// Standard base64 uses + and / which need URL-encoding; base64url replaces them
// with - and _ and omits padding, making it safe in URL fragments.

function arrayBufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');  // remove padding
}

function base64urlToArrayBuffer(base64url) {
  // Restore standard base64 padding and characters
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ── Exports (global, since we're not using a bundler) ─────────────────────────
// All functions are available globally for app.js to call.
window.SecureCrypto = {
  generateFileKey,
  exportKeyToBase64,
  importKeyFromBase64,
  encryptFile,
  decryptFile,
  encryptMeta,
  decryptMeta,
  wrapKeyWithPassword,
  unwrapKeyWithPassword,
  buildFragment,
  parseFragment,
};
