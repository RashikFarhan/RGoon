/**
 * manifest.js
 *
 * Exports two manifest variants:
 *   - baseManifest:        configurable=true  → shown when no :config present (new user)
 *   - installedManifest:   configurable=false → shown when :config IS present (configured user)
 *
 * Stremio shows "Configure" button on configurable=true manifests,
 * and the green "Install" button on configurable=false manifests.
 */

const PORTAL_URL = 'https://rashikfarhan.github.io/RGoon/';

const core = {
    id:          'com.stashio.bridge',
    version:     '1.0.0',
    name:        'Stashio',
    description: 'Bridge between StashDB and public torrent providers',
    resources:   ['catalog', 'meta', 'stream'],
    types:       ['movie'],
    catalogs: [
        {
            type:  'movie',
            id:    'stash_scenes',
            name:  'Stash Scenes',
            extra: [
                { name: 'genre',     isRequired: false },
                { name: 'developer', isRequired: false },
            ],
        },
    ],
};

// ── New user: no config in URL → show Configure button
export const manifest = {
    ...core,
    behaviorHints: {
        configurable:          true,
        configurationRequired: true,
        configurationUrl:      PORTAL_URL,
    },
};

// ── Returning user: config already in URL → show Install button
export const installedManifest = {
    ...core,
    behaviorHints: {
        configurable:          false,
        configurationRequired: false,
        configurationUrl:      PORTAL_URL,
    },
};
