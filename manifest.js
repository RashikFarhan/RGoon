/**
 * manifest.js
 *
 * Exports two manifest variants:
 *   - manifest:         configurable=true  → shown when no :config present (new user)
 *   - installedManifest: configurable=false → shown when :config IS present (configured user)
 */

const PORTAL_URL = 'https://rashikfarhan.github.io/RGoon/';

const core = {
    id:          'com.stashio.bridge',
    version:     '1.0.1',
    name:        'Stashio',
    description: 'Bridge between StashDB and public torrent providers',
    resources:   ['catalog', 'meta', 'stream'],
    types:       ['movie'],
    idPrefixes:  ['stash:'],
    catalogs: [
        {
            type:  'movie',
            id:    'stash_scenes',
            name:  'Stash Scenes',
            extra: [
                // ── search: enables the Stremio search bar for this addon ──
                { name: 'search',    isRequired: false },
                // ── genre / developer: repurposed Studio & Tag filters ──
                { name: 'genre',     isRequired: false },
                { name: 'developer', isRequired: false },
            ],
        },
        {
            type:  'movie',
            id:    'stash_search',
            name:  'Stash Search',
            extra: [
                { name: 'search', isRequired: true }
            ],
        },
    ],
};

// New user: no config in URL → show Configure button
export const manifest = {
    ...core,
    behaviorHints: {
        configurable:          true,
        configurationRequired: true,
        configurationUrl:      PORTAL_URL,
    },
};

// Returning user: config already in URL → show Install button
export const installedManifest = {
    ...core,
    behaviorHints: {
        configurable:          false,
        configurationRequired: false,
        configurationUrl:      PORTAL_URL,
    },
};
