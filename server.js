import express from 'express';
import dotenv from 'dotenv';
import { manifest, installedManifest } from './manifest.js';
import addon from './addon.js';

dotenv.config();

const app   = express();
const PORT  = process.env.PORT || 7000;

// Obtain the SDK's canonical interface object
const addonInterface = addon.getInterface();

// ─────────────────────────────────────────────────────────────
//  CORS — Stremio REQUIRES Access-Control-Allow-Origin: *
//  on every single response. Without this header, Stremio
//  silently drops the response and shows "Could not fetch data."
// ─────────────────────────────────────────────────────────────

app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    next();
});

// ─────────────────────────────────────────────────────────────
//  Dynamic Config Decoder Middleware
//  Decodes the base64 :config segment and attaches the full
//  config object to req.stashContext for every dynamic route.
// ─────────────────────────────────────────────────────────────

app.param('config', (req, _res, next, configParam) => {
    try {
        const configStr = Buffer.from(configParam, 'base64').toString('utf-8');
        const parsed    = JSON.parse(configStr);

        req.stashContext = {
            stashUrl:    parsed.stashUrl    ?? null,
            stashApiKey: parsed.stashApiKey ?? null,
            noLGBT:      parsed.noLGBT      ?? false,
        };

        console.log(`[Stashio] Config decoded | url=${req.stashContext.stashUrl} | noLGBT=${req.stashContext.noLGBT}`);
    } catch {
        console.warn('[Stashio] Could not decode :config param — proceeding without credentials.');
        req.stashContext = { stashUrl: null, stashApiKey: null, noLGBT: false };
    }
    next();
});

// ─────────────────────────────────────────────────────────────
//  Root Route → redirect to Config Portal
// ─────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
    res.redirect('https://rashikfarhan.github.io/RGoon/');
});

// ─────────────────────────────────────────────────────────────
//  Manifest
//  Both /manifest.json (no config) and /:config/manifest.json
// ─────────────────────────────────────────────────────────────

app.get('/manifest.json', (_req, res) => {
    // No config present → show Configure button so the user goes to the portal first
    res.setHeader('Content-Type', 'application/json');
    res.json(manifest);
});

app.get('/:config/manifest.json', (req, res) => {
    // Config IS present in the URL → user is already configured → show green Install button
    res.setHeader('Content-Type', 'application/json');
    res.json(installedManifest);
});

// ─────────────────────────────────────────────────────────────
//  Catalog  GET /:config/catalog/:type/:id.json
// ─────────────────────────────────────────────────────────────

const catalogHandler = async (req, res) => {
    let { type, id, extra } = req.params;

    // Remove the .json extension if it's there
    if (extra && extra.endsWith('.json')) {
        extra = extra.replace('.json', '');
    } else if (id.endsWith('.json')) {
        id = id.replace('.json', '');
    }

    // Parse the extra string into an object (e.g., "search=brazzers" -> { search: "brazzers" })
    const extraObj = {};
    if (extra) {
        extra.split('&').forEach(kv => {
            const [k, v] = kv.split('=');
            if (k && v) extraObj[k] = decodeURIComponent(v);
        });
    }

    try {
        const result = await addonInterface.get('catalog', type, id, extraObj, req.stashContext);
        res.setHeader('Content-Type', 'application/json');
        res.json(result);
    } catch (err) {
        console.error(`[Stashio] /catalog error: ${err.message}`);
        res.json({ metas: [] });
    }
};

app.get('/:config/catalog/:type/:id.json', catalogHandler);
app.get('/:config/catalog/:type/:id/:extra', catalogHandler);

// ─────────────────────────────────────────────────────────────
//  Meta  GET /:config/meta/:type/:id.json
// ─────────────────────────────────────────────────────────────

app.get('/:config/meta/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;

    try {
        const result = await addonInterface.get('meta', type, id, {}, req.stashContext);
        res.setHeader('Content-Type', 'application/json');
        res.json(result);
    } catch (err) {
        console.error(`[Stashio] /meta error: ${err.message}`);
        res.json({ meta: null });
    }
});

// ─────────────────────────────────────────────────────────────
//  Stream  GET /:config/stream/:type/:id.json
// ─────────────────────────────────────────────────────────────

app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;

    try {
        const result = await addonInterface.get('stream', type, id, {}, req.stashContext);
        res.setHeader('Content-Type', 'application/json');
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

export default app;
