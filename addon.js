import { AddonBuilder } from '@stremio-addon/sdk';
import { manifest } from './manifest.js';
import {
    queryStash,
    resolveStudioId,
    resolveTagId,
    GET_SCENES,
    GET_SCENE_DETAILS,
    buildCatalogInput,
} from './stash.js';
import {
    normaliseStudio,
    generateSearchQueries,
    resolveStreams,
} from './streams.js';

// ─────────────────────────────────────────────────────────────
//  Content Filter: Tag Blacklist (Task 2)
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
            const name = p?.performer?.name;
            const alias = p?.as;
            return alias ? `${alias} (${name})` : name;
        })
        .filter(Boolean)
        .join(', ');
}

// ─────────────────────────────────────────────────────────────
//  Task 2: Catalog Handler
//  SDK calls handler({ type, id, extra, config })
//  extra.genre      → repurposed as Studio name filter
//  extra.developer  → repurposed as Tag name filter
// ─────────────────────────────────────────────────────────────

addon.defineCatalogHandler(async ({ type, id, extra, config }) => {
    if (type !== 'movie' || id !== 'stash_scenes') {
        return { metas: [] };
    }

    const studioName = extra?.genre     ?? null;
    const tagName    = extra?.developer ?? null;
    const skip       = parseInt(extra?.skip ?? 0, 10);
    const perPage    = 20;
    const page       = Math.floor(skip / perPage) + 1;

    console.log(
        `[Stashio] Fetching Catalog | Studio: "${studioName ?? 'all'}" | ` +
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

        // ── Task 2: Content Filter ──
        const filterEnabled = config?.noLGBT === true;
        if (filterEnabled) {
            const before = scenes.length;
            scenes = scenes.filter(scene => !isBlacklisted(scene));
            if (scenes.length < before) {
                console.log(`[Stashio] Content filter removed ${before - scenes.length} scene(s).`);
            }
        }

        const metas = scenes.map(scene => ({
            id:          `stash:${scene.id}`,
            type:        'movie',
            name:        scene.title ?? 'Untitled Scene',
            poster:      firstImage(scene.images),
            description: [
                scene.studio?.name ? `Studio: ${scene.studio.name}` : null,
                scene.date         ? `Date: ${scene.date}`          : null,
            ].filter(Boolean).join(' · '),
        }));

        return { metas };
    } catch (err) {
        console.error(`[Stashio] Catalog fetch failed: ${err.message}`);
        return { metas: [] }; // Task 4: graceful degradation — never crash
    }
});

// ─────────────────────────────────────────────────────────────
//  Task 3: Meta Handler
// ─────────────────────────────────────────────────────────────

addon.defineMetaHandler(async ({ type, id, config }) => {
    if (type !== 'movie' || !id.startsWith('stash:')) {
        return { meta: null };
    }

    const stashId = id.replace(/^stash:/, '');

    console.log(
        `[Stashio] Fetching Meta | Scene ID: ${stashId} | from ${config?.stashUrl ?? 'unknown'}`
    );

    try {
        const data  = await queryStash(config, GET_SCENE_DETAILS, { id: stashId });
        const scene = data?.findScene;

        if (!scene) return { meta: null };

        const performers = performerList(scene.performers);
        const poster     = firstImage(scene.images);

        const meta = {
            id:          `stash:${scene.id}`,
            type:        'movie',
            name:        scene.title ?? 'Untitled Scene',

            // Full-resolution scene image as background
            background:  poster,

            // Studio logo as logo (optional — may be null)
            logo:        firstImage(scene.studio?.images),

            // Rich description: scene synopsis + performer credits
            description: [
                scene.details || null,
                performers ? `Performers: ${performers}` : null,
            ].filter(Boolean).join('\n\n'),

            releaseInfo: toYear(scene.date),
            runtime:     toMinutes(scene.duration),
            poster,

            // Tag names surfaced as genres in the Stremio UI
            genres: (scene.tags ?? []).map(t => t.name).filter(Boolean),

            // Official URLs (e.g. scene page on the studio's site)
            links: (scene.urls ?? []).map(u => ({
                name: u.type ?? 'Source',
                category: 'Source',
                url: u.url,
            })),
        };

        return { meta };
    } catch (err) {
        console.error(`[Stashio] Meta fetch failed for ${stashId}: ${err.message}`);
        return { meta: null };
    }
});

// ─────────────────────────────────────────────────────────────
//  Task 1–5: Stream Handler
//  Flow: StashDB metadata → search queries → TPB hunt → filter → map
// ─────────────────────────────────────────────────────────────

addon.defineStreamHandler(async ({ type, id, config }) => {
    if (type !== 'movie' || !id.startsWith('stash:')) {
        return { streams: [] };
    }

    const stashId = id.replace(/^stash:/, '');

    console.log(
        `[Stashio|Streams] Stream request | Scene ID: ${stashId} | ` +
        `from ${config?.stashUrl ?? 'unknown'}`
    );

    // ── Task 1: Fetch minimal scene metadata for query construction ──
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

    console.log(
        `[Stashio|Streams] Scene metadata | Studio: "${studioRaw}" | ` +
        `Title: "${title}" | Date: ${date}`
    );

    // ── Task 2: Generate search query variants ──
    const queries = generateSearchQueries({
        studio: studioRaw,
        title,
        date,
    });

    console.log(`[Stashio|Streams] Query variants: ${JSON.stringify(queries)}`);

    // ── Tasks 3–5: Hunt, filter, map — with 10s hard timeout ──
    const streams = await resolveStreams(queries, null);

    return { streams };
});

export default addon;
