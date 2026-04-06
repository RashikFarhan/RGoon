import { AddonBuilder } from '@stremio-addon/sdk';
import { manifest } from './manifest.js';
import {
    queryStash,
    resolveStudioId,
    resolveTagId,
    searchScenes,
    GET_SCENES,
    GET_SCENE_DETAILS,
    buildCatalogInput,
} from './stash.js';
import {
    generateSearchQueries,
    resolveStreams,
} from './streams.js';

// ─────────────────────────────────────────────────────────────
//  Content Filter: Tag Blacklist
//  Applied when config.noLGBT === true.
// ─────────────────────────────────────────────────────────────

const BLACKLISTED_TAGS = [
    'lgbtq', 'gay', 'homosexual', 'transgender',
    'bisexual', 'queer', 'trans', 'gender', 'non-binary',
];

/**
 * Returns true if the scene should be EXCLUDED from the catalog.
 * Checks every tag name case-insensitively against the blacklist.
 */
function isBlacklisted(scene) {
    const tags = scene?.tags ?? [];
    return tags.some(tag => {
        const name = (tag?.name ?? '').toLowerCase();
        return BLACKLISTED_TAGS.some(bl => name.includes(bl));
    });
}

const addon = new AddonBuilder(manifest);

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

/** First image URL or null */
function firstImage(images) {
    return images?.[0]?.url ?? null;
}

/** Convert raw duration (seconds) to minutes */
function toMinutes(seconds) {
    if (!seconds) return undefined;
    return Math.round(seconds / 60);
}

/** Extract a 4-digit year from an ISO date string e.g. "2022-08-15" */
function toYear(dateStr) {
    return dateStr?.substring(0, 4) ?? undefined;
}

/** Join performer names into a readable list, honouring the `as` alias field */
function performerList(performers = []) {
    return performers
        .map(p => {
            const name  = p?.performer?.name;
            const alias = p?.as;
            return alias ? `${alias} (${name})` : name;
        })
        .filter(Boolean)
        .join(', ');
}

/** Map a raw StashDB scene object → Stremio MetaPreview */
function sceneToMeta(scene) {
    return {
        id:          `stash:${scene.id}`,
        type:        'movie',
        name:        scene.title ?? 'Untitled Scene',
        poster:      firstImage(scene.images),
        description: [
            scene.studio?.name ? `Studio: ${scene.studio.name}` : null,
            scene.date         ? `Date: ${scene.date}`          : null,
        ].filter(Boolean).join(' · '),
    };
}

// ─────────────────────────────────────────────────────────────
//  Catalog Handler
//  Handles two modes:
//    1. Search mode  — extra.search is present (Stremio search bar)
//    2. Browse mode  — normal catalog with optional genre/developer filters
// ─────────────────────────────────────────────────────────────

addon.defineCatalogHandler(async ({ type, id, extra, config }) => {
    if (type !== 'movie' || id !== 'stash_scenes') {
        return { metas: [] };
    }

    const searchQuery = extra?.search    ?? null;
    const studioName  = extra?.genre     ?? null;
    const tagName     = extra?.developer ?? null;
    const skip        = parseInt(extra?.skip ?? 0, 10);
    const perPage     = 20;
    const page        = Math.floor(skip / perPage) + 1;

    const filterEnabled = config?.noLGBT === true;

    // ── MODE 1: Search bar ─────────────────────────────────────
    if (searchQuery) {
        console.log(
            `[Stashio] SEARCH | query="${searchQuery}" | page=${page} | from ${config?.stashUrl ?? 'unknown'}`
        );

        try {
            let scenes = await searchScenes(config, searchQuery, page, perPage);

            if (filterEnabled) {
                const before = scenes.length;
                scenes = scenes.filter(scene => !isBlacklisted(scene));
                if (scenes.length < before) {
                    console.log(`[Stashio] Content filter removed ${before - scenes.length} search result(s).`);
                }
            }

            console.log(`[Stashio] SEARCH returned ${scenes.length} scene(s) for "${searchQuery}"`);
            return { metas: scenes.map(sceneToMeta) };
        } catch (err) {
            console.error(`[Stashio] Search failed: ${err.message}`);
            return { metas: [] };
        }
    }

    // ── MODE 2: Browse with optional Studio / Tag filter ──────
    console.log(
        `[Stashio] BROWSE | Studio: "${studioName ?? 'all'}" | ` +
        `Tag: "${tagName ?? 'all'}" | Page: ${page} | from ${config?.stashUrl ?? 'unknown'}`
    );

    try {
        // Resolve human-readable names → UUIDs in parallel
        const [studioId, tagId] = await Promise.all([
            studioName ? resolveStudioId(config, studioName) : Promise.resolve(null),
            tagName    ? resolveTagId(config, tagName)       : Promise.resolve(null),
        ]);

        const variables = buildCatalogInput({ studioId, tagId, page, perPage });
        const data      = await queryStash(config, GET_SCENES, variables);
        let   scenes    = data?.queryScenes?.scenes ?? [];

        if (filterEnabled) {
            const before = scenes.length;
            scenes = scenes.filter(scene => !isBlacklisted(scene));
            if (scenes.length < before) {
                console.log(`[Stashio] Content filter removed ${before - scenes.length} scene(s).`);
            }
        }

        console.log(`[Stashio] BROWSE returned ${scenes.length} scene(s).`);
        return { metas: scenes.map(sceneToMeta) };
    } catch (err) {
        console.error(`[Stashio] Catalog fetch failed: ${err.message}`);
        return { metas: [] };
    }
});

// ─────────────────────────────────────────────────────────────
//  Meta Handler
// ─────────────────────────────────────────────────────────────

addon.defineMetaHandler(async ({ type, id, config }) => {
    if (type !== 'movie' || !id.startsWith('stash:')) {
        return { meta: null };
    }

    const stashId = id.replace(/^stash:/, '');

    console.log(
        `[Stashio] META | Scene ID: ${stashId} | from ${config?.stashUrl ?? 'unknown'}`
    );

    try {
        const data  = await queryStash(config, GET_SCENE_DETAILS, { id: stashId });
        const scene = data?.findScene;

        if (!scene) return { meta: null };

        const performers = performerList(scene.performers);
        const poster     = firstImage(scene.images);

        return {
            meta: {
                id:          `stash:${scene.id}`,
                type:        'movie',
                name:        scene.title ?? 'Untitled Scene',
                background:  poster,
                logo:        firstImage(scene.studio?.images),
                description: [
                    scene.details || null,
                    performers ? `Performers: ${performers}` : null,
                ].filter(Boolean).join('\n\n'),
                releaseInfo: toYear(scene.date),
                runtime:     toMinutes(scene.duration),
                poster,
                genres: (scene.tags ?? []).map(t => t.name).filter(Boolean),
                links:  (scene.urls ?? []).map(u => ({
                    name:     u.type ?? 'Source',
                    category: 'Source',
                    url:      u.url,
                })),
            },
        };
    } catch (err) {
        console.error(`[Stashio] Meta fetch failed for ${stashId}: ${err.message}`);
        return { meta: null };
    }
});

// ─────────────────────────────────────────────────────────────
//  Stream Handler
//  Flow: StashDB metadata → search queries → TPB hunt → filter → map
// ─────────────────────────────────────────────────────────────

addon.defineStreamHandler(async ({ type, id, config }) => {
    if (type !== 'movie' || !id.startsWith('stash:')) {
        return { streams: [] };
    }

    const stashId = id.replace(/^stash:/, '');

    console.log(
        `[Stashio|Streams] STREAM request | Scene ID: ${stashId} | from ${config?.stashUrl ?? 'unknown'}`
    );

    // Fetch full scene metadata for query construction
    let scene = null;
    try {
        const data = await queryStash(config, GET_SCENE_DETAILS, { id: stashId });
        scene = data?.findScene ?? null;
    } catch (err) {
        console.error(`[Stashio|Streams] StashDB lookup failed: ${err.message}`);
        return { streams: [] };
    }

    if (!scene) {
        console.warn(`[Stashio|Streams] Scene ${stashId} not found in StashDB.`);
        return { streams: [] };
    }

    const studioRaw = scene.studio?.name ?? '';
    const title     = scene.title        ?? '';
    const date      = scene.date         ?? '';
    const code      = scene.code         ?? '';

    let hashQuery = null;
    if (scene.fingerprints && Array.isArray(scene.fingerprints)) {
        // Find OSHASH or MD5 as fallback torrent search
        const fp = scene.fingerprints.find(f => f.algorithm === 'OSHash' || f.algorithm === 'MD5' || f.algorithm === 'OSHASH' || f.algorithm === 'md5');
        if (fp) {
            hashQuery = fp.hash;
        }
    }

    console.log(
        `[Stashio|Streams] Metadata | Studio: "${studioRaw}" | Title: "${title}" | Date: ${date} | Code: ${code} | Hash: ${hashQuery}`
    );

    // Generate multi-variant search query strings
    const queries = generateSearchQueries({ studio: studioRaw, title, date, code });
    if (hashQuery) {
        queries.unshift(hashQuery); // Try hash search first!
    }

    console.log(`[Stashio|Streams] Query variants: ${JSON.stringify(queries)}`);

    // Hunt, filter, and map to Stremio stream objects (15s hard deadline inside resolveStreams)
    const streams = await resolveStreams(queries, null);
    console.log(`[Stashio|Streams] Found ${streams.length} streams`);

    return { streams };
});

export default addon;
