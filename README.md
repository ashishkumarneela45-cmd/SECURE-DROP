# SecureDrop — Encrypted File Sharing

A personal learning project implementing end-to-end encrypted file sharing in the browser.
**Not affiliated with the real-world SecureDrop whistleblower platform.**

## How it works (the short version)

```
Upload side:
  Browser → generate random AES-256 key
         → encrypt file with that key (AES-GCM)
         → upload only the ciphertext to server
         → put the key in the URL fragment (#) — server never sees it

Download side:
  Browser → read key from URL fragment (server never sent it)
         → fetch encrypted blob from server
         → decrypt locally
         → save file to disk
```

The server is "zero-knowledge" — it stores encrypted bytes it cannot read.

## Quick start

### Prerequisites
- [Node.js](https://nodejs.org) 18+

### Run the backend

```bash
cd backend
npm install
npm start
```

Then open [http://localhost:3001](http://localhost:3001) in your browser.
The backend serves the frontend files automatically.

### Development (auto-reload)

```bash
cd backend
npm run dev
```

## Project structure

```
securedrop/
├── backend/
│   ├── server.js        # Express API — upload, download, cleanup
│   ├── package.json
│   └── uploads/         # Encrypted blobs stored here (auto-cleaned)
└── frontend/
    └── src/
        ├── index.html   # Upload page + download page (single HTML file, routed by URL fragment)
        ├── crypto.js    # All encryption logic — Web Crypto API (AES-256-GCM + PBKDF2)
        ├── app.js       # UI logic — upload flow, download flow, QR code
        └── style.css    # Dark theme stylesheet
```

## API

| Method | Path                  | Description                                          |
|--------|-----------------------|------------------------------------------------------|
| POST   | `/api/upload`         | Upload encrypted blob + settings → returns `{ id }` |
| GET    | `/api/file/:id/meta`  | Get encrypted metadata + link status                 |
| GET    | `/api/file/:id`       | Stream the encrypted blob (increments counter)       |

## Security notes

- **AES-256-GCM** — authenticated encryption (detects tampering)
- **IV (Initialization Vector)** — random 96-bit value, prepended to ciphertext
- **URL fragment (#)** — never sent to server by browsers (HTTP spec)
- **PBKDF2 (200k iterations)** — for optional password protection, resists brute-force
- **No accounts** — anonymous, link-only sharing
- **Auto-delete** — files deleted when expiry time or download limit is hit

## Limitations (learning project)

- In-memory file registry resets on server restart (uploaded files are orphaned and cleaned up)
- No rate limiting or abuse protection
- 100 MB file size limit
- For production use you'd want: persistent storage (SQLite/Redis), rate limiting, HTTPS enforcement, and a proper domain
