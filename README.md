# 🎬 Stashio Bridge

> A Stremio addon that bridges your private **StashDB** collection with public torrent providers — no IMDb IDs needed.

---

## ✨ How It Works

1. You enter your StashDB URL + API Key into the **Config Portal**.
2. The portal generates a secret, Base64-encoded configuration URL.
3. You click **Install** — Stremio opens automatically and installs the addon.
4. When you click any scene, Stashio searches **The Pirate Bay** using the Studio + Release Date as the unique key.
5. Stremio's built-in torrent engine plays the stream directly. No separate player needed.

---

## 🚀 Quick Start

### 1. Use the Config Portal (Recommended)

Visit the GitHub Pages site for this repo and fill in your details:

```
https://<your-github-username>.github.io/stashio-bridge/
```

### 2. Manual Installation

Construct your config JSON, Base64-encode it, and open this URL in Stremio:

```
stremio://<YOUR_ADDON_HOST>/<BASE64_CONFIG>/manifest.json
```

**Config JSON format:**
```json
{
  "stashUrl": "https://stashdb.org/graphql",
  "stashApiKey": "YOUR_JWT_API_KEY",
  "noLGBT": false
}
```

---

## 🛠 Self-Hosting the Backend

The backend must be hosted on a server (not GitHub Pages). Recommended platforms:

| Platform | Free tier | Steps |
|----------|-----------|-------|
| **Vercel** | ✅ Yes | `npx vercel` in the project root |
| **Render** | ✅ Yes | Connect repo → set start command to `npm start` |
| **Railway** | ✅ Yes | Connect repo → auto-detected |

### Local Development

```bash
# 1. Clone the repo
git clone https://github.com/<you>/stashio-bridge.git
cd stashio-bridge

# 2. Install dependencies
npm install

# 3. Start the server
npm start
# → Stashio Addon is live at http://localhost:7000
```

Then open `index.html` in a browser, set the URL to `http://localhost:7000`, and install!

---

## 🔧 Backend Routes

| Route | Description |
|-------|-------------|
| `GET /manifest.json` | Addon manifest (no auth) |
| `GET /:config/manifest.json` | Manifest with decoded config |
| `GET /:config/catalog/movie/stash_scenes.json` | Scene list from StashDB |
| `GET /:config/meta/movie/stash:<uuid>.json` | Full scene details |
| `GET /:config/stream/movie/stash:<uuid>.json` | Torrent streams from TPB |

---

## 🛡 Family-Safe Mode

Enable the **Family-Safe Mode** toggle in the Config Portal to automatically exclude scenes tagged with LGBTQ-related tags (`Gay`, `Lesbian`, `Transgender`, etc.) from your catalog.

---

## 📁 Project Structure

```
stashio-bridge/
├── index.html      ← Config Portal (static, GitHub Pages)
├── server.js       ← Express server + route wiring
├── addon.js        ← Stremio protocol (catalog/meta/stream handlers)
├── stash.js        ← GraphQL engine for StashDB
├── streams.js      ← TPB search, filtering & stream mapping
├── manifest.js     ← Stremio addon manifest
├── package.json
└── .gitignore
```

---

## 📝 License

MIT
