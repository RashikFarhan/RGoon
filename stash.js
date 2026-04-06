import axios from 'axios';

// ─────────────────────────────────────────────────────────────
//  Core GraphQL Executor
// ─────────────────────────────────────────────────────────────

/**
 * Sends a GraphQL query to the StashDB instance described by `config`.
 * @param {{ stashUrl: string, stashApiKey: string }} config
 * @param {string} query      - GraphQL query string
 * @param {object} variables  - GraphQL variables
 * @returns {Promise<object>} - The `data` object from the GraphQL response
 */
export async function queryStash(config, query, variables = {}) {
    const { stashUrl, stashApiKey } = config;

    const response = await axios.post(
        stashUrl,
        { query, variables },
        {
            headers: {
                'Content-Type': 'application/json',
                'ApiKey': stashApiKey,
            },
            timeout: 15_000,
        }
    );

    if (response.data.errors?.length > 0) {
        const msg = response.data.errors.map(e => e.message).join('; ');
        throw new Error(`StashDB GraphQL error: ${msg}`);
    }

    return response.data.data;
}

// ─────────────────────────────────────────────────────────────
//  Query: Studio lookup by name  →  returns the first matching ID
// ─────────────────────────────────────────────────────────────

const FIND_STUDIO_BY_NAME = /* GraphQL */ `
    query FindStudio($name: String!) {
        queryStudios(input: { name: $name, per_page: 1, page: 1 }) {
            studios { id name }
        }
    }
`;

/**
 * Resolves a human-readable studio name to its UUID.
 * Returns null if not found.
 */
export async function resolveStudioId(config, studioName) {
    try {
        const data = await queryStash(config, FIND_STUDIO_BY_NAME, { name: studioName });
        return data?.queryStudios?.studios?.[0]?.id ?? null;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
//  Query: Tag lookup by name  →  returns the first matching ID
// ─────────────────────────────────────────────────────────────

const FIND_TAG_BY_NAME = /* GraphQL */ `
    query FindTag($name: String!) {
        queryTags(input: { name: $name, per_page: 1, page: 1 }) {
            tags { id name }
        }
    }
`;

/**
 * Resolves a human-readable tag name to its UUID.
 * Returns null if not found.
 */
export async function resolveTagId(config, tagName) {
    try {
        const data = await queryStash(config, FIND_TAG_BY_NAME, { name: tagName });
        return data?.queryTags?.tags?.[0]?.id ?? null;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
//  Query: Scene List (Catalog)
//  Uses queryScenes(input: SceneQueryInput) — the real StashDB API.
//  studios / tags accept MultiIDCriterionInput { value: [ID!]!, modifier: MODIFIER }
// ─────────────────────────────────────────────────────────────

export const GET_SCENES = /* GraphQL */ `
    query QueryScenes($input: SceneQueryInput!) {
        queryScenes(input: $input) {
            count
            scenes {
                id
                title
                date
                duration
                images { url }
                studio { id name }
                performers {
                    performer { id name }
                }
                tags { id name }
            }
        }
    }
`;

// ─────────────────────────────────────────────────────────────
//  Hybrid Scene Search
//
//  Problem: StashDB's `text` field is a phrase matcher.
//  "Angela White" → 701 results  ✓
//  "Brazzers Angela White" → 0 results  ✗
//
//  Solution: Tokenize the query, fan out to multiple parallel
//  searches (text, title, performer name, studio name), merge
//  all unique results, then rank them by how many tokens from
//  the original query appear in each scene's metadata.
//  This gives a real relevance-ranked hybrid search.
// ─────────────────────────────────────────────────────────────

const SCENE_FIELDS = /* GraphQL */ `
    id title date duration
    images { url }
    studio { id name }
    performers { performer { id name } }
    tags { id name }
`;

/** Run a single queryScenes call with arbitrary input */
async function runQuery(config, input) {
    const gql = `
        query($input: SceneQueryInput!) {
            queryScenes(input: $input) {
                scenes { ${SCENE_FIELDS} }
            }
        }`;
    const data = await queryStash(config, gql, { input });
    return data?.queryScenes?.scenes ?? [];
}

/**
 * Score a scene against a set of lower-cased query tokens.
 * Each token that appears in any metadata field adds 1 point.
 * A hit in title/performer is worth more than a generic text match.
 */
function scoreScene(scene, tokens) {
    const fields = [
        scene.title ?? '',
        scene.studio?.name ?? '',
        ...(scene.performers ?? []).map(p => p.performer?.name ?? ''),
        ...(scene.tags ?? []).map(t => t.name ?? ''),
    ].map(f => f.toLowerCase());

    const haystack = fields.join(' ');
    return tokens.reduce((score, tok) => score + (haystack.includes(tok) ? 1 : 0), 0);
}

/**
 * Smart hybrid search.
 *
 * Strategy:
 *  1. Run `text` query against the full raw query (catches simple cases).
 *  2. Split query into tokens; run `text` for each token individually.
 *  3. Merge results, deduplicate by ID, rank by token match score.
 *
 * @param {{ stashUrl: string, stashApiKey: string }} config
 * @param {string} rawQuery  - the user's exact search string
 * @param {number} page
 * @param {number} perPage
 */
export async function searchScenes(config, rawQuery, page = 1, perPage = 20) {
    const trimmed = rawQuery.trim();
    if (!trimmed) return [];

    const tokens = trimmed.toLowerCase().split(/\s+/).filter(t => t.length > 1);

    // Base input defaults
    const baseInput = { page, per_page: perPage, sort: 'DATE', direction: 'DESC' };

    // Build all query variants to run in parallel
    const queryVariants = [
        // 1. The full phrase as-is (works for single-field queries like "Angela White")
        runQuery(config, { ...baseInput, text: trimmed }),
    ];

    // 2. For hybrid queries with 2+ tokens: try each token separately so
    //    StashDB can match across different fields (performer, studio, title, tags)
    if (tokens.length >= 2) {
        for (const tok of tokens) {
            queryVariants.push(runQuery(config, { ...baseInput, text: tok }));
        }
    }

    // 3. Run all variants in parallel
    const allArrays = await Promise.all(queryVariants);

    // 4. Merge and deduplicate by ID
    const seen   = new Map(); // id → { scene, score }
    for (const scenes of allArrays) {
        for (const scene of scenes) {
            if (!seen.has(scene.id)) {
                seen.set(scene.id, { scene, score: scoreScene(scene, tokens) });
            }
        }
    }

    // 5. Sort by relevance (most matched tokens first), then by date
    const ranked = [...seen.values()]
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (b.scene.date ?? '').localeCompare(a.scene.date ?? '');
        })
        .slice(0, perPage)
        .map(r => r.scene);

    return ranked;
}




// ─────────────────────────────────────────────────────────────
//  Query: Single Scene Full Detail (Meta)
// ─────────────────────────────────────────────────────────────

export const GET_SCENE_DETAILS = /* GraphQL */ `
    query FindScene($id: ID!) {
        findScene(id: $id) {
            id
            title
            code
            date
            details
            duration
            images { url }
            studio {
                id
                name
                parent { id name }
                images { url }
            }
            performers {
                as
                performer { id name }
            }
            tags { id name }
            urls { url type }
            fingerprints {
                algorithm
                hash
            }
        }
    }
`;

// ─────────────────────────────────────────────────────────────
//  Helpers: Build GraphQL Variables for Catalog Query
// ─────────────────────────────────────────────────────────────

/**
 * Builds the `input` variable for queryScenes.
 * @param {{
 *   studioId?: string|null,
 *   tagId?: string|null,
 *   page?: number,
 *   perPage?: number
 * }} opts
 */
export function buildCatalogInput({ studioId, tagId, page = 1, perPage = 20 } = {}) {
    const input = {
        page,
        per_page: perPage,
        sort: 'DATE',
        direction: 'DESC',
    };

    if (studioId) {
        input.studios = { value: [studioId], modifier: 'INCLUDES' };
    }

    if (tagId) {
        input.tags = { value: [tagId], modifier: 'INCLUDES' };
    }

    return { input };
}
