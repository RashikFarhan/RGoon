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
//  Query: Full-text Scene Search (Search bar)
//  StashDB's `text` field matches against title, performer names,
//  studio names, and tags in a single pass.
// ─────────────────────────────────────────────────────────────

export const SEARCH_SCENES = /* GraphQL */ `
    query SearchScenes($input: SceneQueryInput!) {
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

/**
 * Performs a free-text search across scenes.
 * @param {{ stashUrl: string, stashApiKey: string }} config
 * @param {string} query  - the user's search string
 * @param {number} page
 * @param {number} perPage
 */
export async function searchScenes(config, query, page = 1, perPage = 20) {
    const variables = {
        input: {
            text:      query,
            page,
            per_page:  perPage,
            sort:      'DATE',
            direction: 'DESC',
        },
    };
    const data = await queryStash(config, SEARCH_SCENES, variables);
    return data?.queryScenes?.scenes ?? [];
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
