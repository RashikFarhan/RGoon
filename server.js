import express from 'express';
import dotenv from 'dotenv';
import { manifest } from './manifest.js';
import addon from './addon.js';

dotenv.config();

const app   = express();
const PORT  = process.env.PORT || 7000;

// Obtain the SDK's canonical interface object
// .get(resource, type, id, extra, config) dispatches to the correct handler
const addonInterface = addon.getInterface();

// ─────────────────────────────────────────────────────────────
//  Dynamic Config Decoder Middleware
//  Decodes the base64 :config path segment and attaches
//  { stashUrl, stashApiKey } to req.stashContext for every
//  dynamic route that carries a :config param.
// ─────────────────────────────────────────────────────────────

app.param('config', (req, _res, next, configParam) => {
    try {
        const configStr = Buffer.from(configParam, 'base64').toString('utf-8');
        const parsed    = JSON.parse(configStr);

        req.stashContext = {
            stashUrl:    parsed.stashUrl,
            stashApiKey: parsed.stashApiKey,
        };
    } catch {
        console.warn('[Stashio] Could not decode :config param — proceeding without credentials.');
        req.stashContext = {};
    }
    next();
});

// ─────────────────────────────────────────────────────────────
//  Manifest & Root Routes
// ─────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
    res.redirect('https://rashikfarhan.github.io/RGoon/');
});

app.get('/manifest.json',         (_req, res) => res.json(manifest));
app.get('/:config/manifest.json', (_req, res) => res.json(manifest));

// ─────────────────────────────────────────────────────────────
//  Catalog  GET /:config/catalog/:type/:id.json
//  Query-string extras: ?genre=Studio+Name&developer=Tag+Name
// ─────────────────────────────────────────────────────────────

app.get('/:config/catalog/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const extra        = req.query;              // Stremio passes filters as QS

    try {
        // Pass stashContext as the SDK `config` argument
        const result = await addonInterface.get('catalog', type, id, extra, req.stashContext);
        res.json(result);
    } catch (err) {
        console.error(`[Stashio] /catalog error: ${err.message}`);
        res.json({ metas: [] });
    }
});

// ─────────────────────────────────────────────────────────────
//  Meta  GET /:config/meta/:type/:id.json
// ─────────────────────────────────────────────────────────────

app.get('/:config/meta/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;

    try {
        const result = await addonInterface.get('meta', type, id, {}, req.stashContext);
        res.json(result);
    } catch (err) {
        console.error(`[Stashio] /meta error: ${err.message}`);
        res.json({ meta: null });
    }
});

// ─────────────────────────────────────────────────────────────
//  Stream  GET /:config/stream/:type/:id.json  (Chunk 3)
// ─────────────────────────────────────────────────────────────

app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;

    try {
        const result = await addonInterface.get('stream', type, id, {}, req.stashContext);
        res.json(result);
    } catch (err) {
        console.error(`[Stashio] /stream error: ${err.message}`);
        res.json({ streams: [] });
    }
});

// ─────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`Stashio Addon is live at http://localhost:${PORT}`);
});
