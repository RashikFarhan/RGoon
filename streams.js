import axios from 'axios';

// ─────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.wmv', '.ts', '.webm']);
const TPB_SEARCH_URL   = 'https://apibay.org/q.php';
const TPB_FILES_URL    = 'https://apibay.org/f.php';
const ADULT_CATEGORIES = '500,501,502,503,504,505,506,507'; // TPB adult categories
const TIMEOUT_MS       = 14_000; // leave 1 s buffer under the 15 s deadline

// ─────────────────────────────────────────────────────────────
//  Task 1: Metadata Normalisation
// ─────────────────────────────────────────────────────────────

/**
 * Strips characters that torrent uploaders typically drop from studio names
 * (punctuation, extra whitespace) so queries match real torrent titles.
 * e.g. "Brazzers.com" → "Brazzers", "Evil Angel" → "Evil Angel"
 */
export function normaliseStudio(name = '') {
    return name
        .replace(/\.com$/i, '')           // remove trailing .com / .net
        .replace(/[^\w\s]/g, ' ')         // replace non-word chars with space
        .replace(/\s+/g, ' ')             // collapse whitespace
        .trim();
}

/**
 * Returns the date in the uploader-friendly format most used on TPB:
 *   YYYY-MM-DD  (already the StashDB format — kept as-is)
 *   Also produces a DD.MM.YYYY variant used by some uploaders.
 */
export function formatDate(isoDate = '') {
    if (!isoDate) return { iso: '', dot: '' };
    const [year, month, day] = isoDate.split('-');
    return {
        iso: isoDate,                             // 2023-08-15
        dot: `${day}.${month}.${year}`,           // 15.08.2023  (common TPB style)
    };
}

// ─────────────────────────────────────────────────────────────
//  Task 2: Search Query Constructor
// ─────────────────────────────────────────────────────────────

/**
 * Generates multiple query variants to maximise TPB hit rate.
 * @param {{ studio: string, title: string, date: string }} sceneMetadata
 * @returns {string[]}  ordered array of queries, most-specific first
 */
export function generateSearchQueries({ studio, title, date }) {
    const studioClean = normaliseStudio(studio);
    const { iso, dot } = formatDate(date);
    const queries = [];

    // Primary: Studio + ISO date  (most unique identifier in P2P world)
    if (studioClean && iso)  queries.push(`${studioClean} ${iso}`);

    // Secondary: Studio + dot-style date  (alternate uploader convention)
    if (studioClean && dot)  queries.push(`${studioClean} ${dot}`);

    // Tertiary: Studio + Scene Title  (fallback for scenes without a date)
    if (studioClean && title) queries.push(`${studioClean} ${title}`);

    // Final catch-all: just the title
    if (title)               queries.push(title);

    // De-duplicate while preserving order
    return [...new Set(queries)];
}

// ─────────────────────────────────────────────────────────────
//  Task 3: Provider Integration – The Pirate Bay
// ─────────────────────────────────────────────────────────────

/**
 * Searches TPB for a single query string.
 * Returns raw TPB torrent objects (may be empty / [{ name: 'No results' }]).
 */
async function searchTPB(query) {
    const params = {
        q:   query,
        cat: ADULT_CATEGORIES,
    };

    const { data } = await axios.get(TPB_SEARCH_URL, { params, timeout: TIMEOUT_MS });

    if (!Array.isArray(data)) return [];
    // TPB returns [{ name: 'No results found' }] when empty
    return data.filter(t => t.info_hash && t.info_hash !== '0000000000000000000000000000000000000000');
}

/**
 * Fetches the file list for a single TPB torrent ID.
 * Returns [{ name, size }] or [] on failure.
 */
async function fetchTPBFiles(torrentId) {
    try {
        const { data } = await axios.get(TPB_FILES_URL, {
            params:  { id: torrentId },
            timeout: TIMEOUT_MS,
        });
        if (!data?.name) return [];
        return data.name.map((name, i) => ({ name, size: data.size?.[i] ?? 0 }));
    } catch {
        return [];
    }
}

/**
 * Checks whether a filename has a recognised video extension.
 */
function isVideoFile(filename = '') {
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
}

/**
 * Runs up to `maxQueries` search strings against TPB in sequence,
 * stopping as soon as at least one valid result is found.
 * Deduplicates by infoHash and returns to caller.
 *
 * @param {string[]} queries
 * @returns {Promise<object[]>}  array of enriched TPB torrent objects
 */
export async function fetchExternalStreams(queries, maxQueries = 3) {
    const seen    = new Set();
    const results = [];

    for (const query of queries.slice(0, maxQueries)) {
        console.log(`[Stashio|Streams] Searching TPB: "${query}"`);
        let torrents = [];

        try {
            torrents = await searchTPB(query);
        } catch (err) {
            console.warn(`[Stashio|Streams] TPB query failed for "${query}": ${err.message}`);
            continue;
        }

        for (const torrent of torrents) {
            const hash = torrent.info_hash?.toLowerCase();
            if (!hash || seen.has(hash)) continue;
            seen.add(hash);
            results.push(torrent);
        }

        // Stop early if we already have good results — avoids wasting quota
        if (results.length >= 5) break;
    }

    return results;
}

// ─────────────────────────────────────────────────────────────
//  Task 3b: File index resolution for multi-file torrents
// ─────────────────────────────────────────────────────────────

/**
 * Given a TPB torrent, returns the best fileIdx:
 *   - For single-file torrents: 0
 *   - For multi-file torrents: index of the largest video file
 *   - Falls back to 0 if file info cannot be retrieved
 */
export async function resolveBestFileIdx(torrent) {
    const numFiles = parseInt(torrent.num_files ?? '1', 10);
    if (numFiles <= 1) return 0;

    const files = await fetchTPBFiles(torrent.id);
    if (!files.length) return 0;

    let bestIdx  = 0;
    let bestSize = -1;

    files.forEach(({ name, size }, idx) => {
        if (isVideoFile(name) && size > bestSize) {
            bestSize = size;
            bestIdx  = idx;
        }
    });

    return bestIdx;
}

// ─────────────────────────────────────────────────────────────
//  Task 4: Result Mapping → Stremio Stream Protocol
// ─────────────────────────────────────────────────────────────

/** Formats bytes to a human-readable size string */
function formatSize(bytes) {
    if (!bytes || bytes === '0') return '';
    const b = parseInt(bytes, 10);
    if (b > 1_073_741_824) return `${(b / 1_073_741_824).toFixed(2)} GB`;
    if (b > 1_048_576)     return `${(b / 1_048_576).toFixed(0)} MB`;
    return `${b} B`;
}

/** Infers quality label from torrent name */
function inferQuality(name = '') {
    const n = name.toUpperCase();
    if (n.includes('2160') || n.includes('4K') || n.includes('UHD')) return '4K';
    if (n.includes('1080'))                                           return '1080p';
    if (n.includes('720'))                                            return '720p';
    if (n.includes('480'))                                            return '480p';
    return 'SD';
}

/**
 * Task 5: Content filtering.
 * Removes torrents whose primary inferred filename isn't a video extension.
 * (For single-file TPB entries the name itself often includes the extension.)
 */
function passesContentFilter(torrent) {
    const name = (torrent.name ?? '').toLowerCase();

    // If the name itself has a video ext, it's valid
    if (VIDEO_EXTENSIONS.has(name.slice(name.lastIndexOf('.')))) return true;

    // Single-file torrents with no ext in name: allow through (file info checked later)
    if (parseInt(torrent.num_files ?? '1', 10) === 1) return true;

    return false; // multi-file torrent with no recognisable video name — skip
}

/**
 * Task 5 (optional): Size validation.
 * If `expectedBytes` is provided, reject torrents whose size differs by > 20%.
 */
function passesSizeCheck(torrent, expectedBytes = null) {
    if (!expectedBytes) return true;
    const actual = parseInt(torrent.size ?? '0', 10);
    if (!actual) return true;
    const ratio = actual / expectedBytes;
    return ratio >= 0.8 && ratio <= 1.2;
}

/**
 * Converts a single enriched TPB torrent + resolved fileIdx into a Stremio stream object.
 */
export function mapToStremioStream(torrent, fileIdx = 0) {
    const quality  = inferQuality(torrent.name);
    const seeders  = torrent.seeders  ?? '?';
    const size     = formatSize(torrent.size);
    const provider = 'ThePirateBay';

    return {
        infoHash: torrent.info_hash.toLowerCase(),
        fileIdx,
        name:  `Stashio | ${provider}`,
        title: [
            `${quality}${size ? ` | 💾 ${size}` : ''}`,
            `👤 ${seeders} seeders`,
            `⚙️ ${provider}`,
            torrent.name,
        ].join('\n'),
        behaviorHints: {
            filename: torrent.name,
        },
    };
}

// ─────────────────────────────────────────────────────────────
//  Public: Full Stream Resolution Pipeline
// ─────────────────────────────────────────────────────────────

/**
 * Orchestrates the full pipeline:
 *   queries → TPB search → filter → fileIdx resolution → Stremio stream objects
 *
 * Hard 10-second deadline via Promise.race.
 *
 * @param {string[]}   queries        - ordered search strings (from generateSearchQueries)
 * @param {number|null} expectedBytes - optional scene file size for size validation
 * @returns {Promise<object[]>}       - Stremio stream objects
 */
export async function resolveStreams(queries, expectedBytes = null) {
    const pipeline = async () => {
        const raw = await fetchExternalStreams(queries);

        // Apply content + size filters
        const filtered = raw.filter(
            t => passesContentFilter(t) && passesSizeCheck(t, expectedBytes)
        );

        if (!filtered.length) {
            console.log('[Stashio|Streams] No streams passed filters.');
            return [];
        }

        // Resolve fileIdx for each torrent (fetches file list for multi-file torrents)
        const streams = await Promise.all(
            filtered.map(async torrent => {
                const fileIdx = await resolveBestFileIdx(torrent);
                return mapToStremioStream(torrent, fileIdx);
            })
        );

        console.log(`[Stashio|Streams] Resolved ${streams.length} stream(s).`);
        return streams;
    };

    // Hard timeout guard — never hang Stremio
    const timeout = new Promise(resolve => setTimeout(() => {
        console.warn('[Stashio|Streams] Stream resolution timed out after 15s — returning []');
        resolve([]);
    }, 15_000));

    return Promise.race([pipeline(), timeout]);
}
