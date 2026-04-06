import axios from 'axios';
import * as cheerio from 'cheerio';

// ─────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.wmv', '.ts', '.webm', '.flv']);

const TPB_SEARCH_URL   = 'https://apibay.org/q.php';
const TPB_FILES_URL    = 'https://apibay.org/f.php';
// TorrentGalaxy mirrors — tried in order until one responds
const TGX_MIRRORS      = [
    'https://tgx.rs/torrents.php',
    'https://torrentgalaxy.to/torrents.php',
    'https://torrentgalaxy.mx/torrents.php',
];

// TPB adult categories: 500=XXX, 501=XXX/MovClips, 502=XXX/Movies,
// 504=XXX/Other, 505=XXX/Clips, 506=XXX/HD_Movies, 507=XXX/SD
const ADULT_CATEGORIES = '500,501,502,504,505,506,507';

const TPB_TIMEOUT      = 6_000;   // TPB is a clean JSON API — should respond fast
const TGX_MIRROR_TIMEOUT = 4_000; // per-mirror timeout for TGX; mirrors can be slow/down
const TOTAL_TIMEOUT_MS = 14_000;  // hard deadline (keep under Vercel 15s limit)

// ─────────────────────────────────────────────────────────────
//  Metadata Normalisation
// ─────────────────────────────────────────────────────────────

/**
 * Strips TLDs, punctuation, and extra whitespace from studio names.
 * "Brazzers.com" → "Brazzers",  "Evil Angel" → "Evil Angel"
 */
export function normaliseStudio(name = '') {
    return name
        .replace(/\.(com|net|org|xxx)$/i, '')
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Strips colons, hyphens, and other punctuation from scene titles.
 * TPB's search engine chokes on non-alphanumeric characters.
 */
export function normaliseTitle(title = '') {
    return title
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Returns the date in multiple uploader-convention formats.
 *  dot:  DD.MM.YYYY  (15.04.2026) — most common on TPB for adult scenes
 *  us:   MM.DD.YYYY  (04.15.2026) — seen occasionally
 *  iso:  YYYY-MM-DD               — rare on TPB
 *  year: YYYY                     — broad fallback
 */
export function formatDate(isoDate = '') {
    if (!isoDate) return { iso: '', dot: '', us: '', year: '' };
    const [year, month, day] = isoDate.split('-');
    return {
        iso:  isoDate,
        dot:  `${day}.${month}.${year}`,
        us:   `${month}.${day}.${year}`,
        year,
    };
}

// ─────────────────────────────────────────────────────────────
//  Query Matrix Constructor
//
//  Real-world TPB naming patterns for adult content:
//    "Brazzers - Performer1, Performer2 - SceneTitle (DD.MM.YYYY)"
//    "Brazzers Exxtra - Performer - SceneTitle 480p"
//
//  The KEY insight: TPB uploaders use the PARENT brand name, not
//  sub-network names.  "Brazzers Exxtra" scenes are indexed under "Brazzers".
// ─────────────────────────────────────────────────────────────

/**
 * Builds an ordered list of search query variants, most-specific first.
 *
 * @param {{
 *   studio:       string,   // sub-network e.g. "Brazzers Exxtra"
 *   parentStudio: string,   // parent brand e.g. "Brazzers"
 *   title:        string,
 *   date:         string,   // YYYY-MM-DD
 *   code:         string,   // scene code e.g. "11474955"
 *   performers:   string[]  // performer name list
 * }} metadata
 */
export function generateSearchQueries({ studio, parentStudio, title, date, code, performers = [] }) {
    const studioClean = normaliseStudio(studio);
    const parentClean = normaliseStudio(parentStudio || studio);
    const titleClean  = normaliseTitle(title);
    const { iso, dot, us, year } = formatDate(date);
    const queries = [];

    // Tier 1: Parent brand + DD.MM.YYYY  (most common real-world TPB pattern)
    if (parentClean && dot)        queries.push(`${parentClean} ${dot}`);

    // Tier 2: Parent brand + clean title keywords
    if (parentClean && titleClean) queries.push(`${parentClean} ${titleClean}`);

    // Tier 3: Parent brand + US date format
    if (parentClean && us)         queries.push(`${parentClean} ${us}`);

    // Tier 4: Parent brand + ISO date
    if (parentClean && iso)        queries.push(`${parentClean} ${iso}`);

    // Tier 5: Sub-network + DD.MM.YYYY  (for studios that ARE the uploader brand)
    if (studioClean && dot && studioClean !== parentClean)
                                   queries.push(`${studioClean} ${dot}`);

    // Tier 6: Top performer + parent + year
    const topPerformer = performers[0] ? normaliseTitle(performers[0]) : '';
    if (topPerformer && parentClean && year)
                                   queries.push(`${parentClean} ${topPerformer} ${year}`);

    // Tier 7: Scene code (unique identifier some uploaders tag onto releases)
    if (code)                      queries.push(code);

    // Tier 8: Title-only broad fallback
    if (titleClean)                queries.push(titleClean);

    return [...new Set(queries)];
}

// ─────────────────────────────────────────────────────────────
//  Provider 1: The Pirate Bay  (apibay.org public JSON API)
// ─────────────────────────────────────────────────────────────

async function searchTPB(query) {
    const url = `${TPB_SEARCH_URL}?q=${encodeURIComponent(query)}&cat=${ADULT_CATEGORIES}`;
    try {
        const { data } = await axios.get(url, { timeout: TPB_TIMEOUT });
        if (!Array.isArray(data)) return [];

        return data
            .filter(t => t.info_hash && t.info_hash !== '0000000000000000000000000000000000000000')
            .map(t => ({
                info_hash: t.info_hash.toLowerCase(),
                name:      t.name,
                size:      parseInt(t.size, 10) || 0,
                seeders:   parseInt(t.seeders, 10) || 0,
                num_files: parseInt(t.num_files, 10) || 1,
                id:        t.id,
                provider:  'TPB',
            }));
    } catch (err) {
        console.warn(`[Stashio|TPB] "${query}" failed: ${err.message}`);
        return [];
    }
}

async function fetchTPBFiles(torrentId) {
    try {
        const { data } = await axios.get(`${TPB_FILES_URL}?id=${torrentId}`, { timeout: 5000 });
        if (!data?.name) return [];
        return data.name.map((name, i) => ({ name, size: parseInt(data.size?.[i], 10) || 0 }));
    } catch {
        return [];
    }
}

// ─────────────────────────────────────────────────────────────
//  Provider 2: TorrentGalaxy  (HTML scrape)
//  TGX has one of the largest dedicated adult torrent indexes.
//  We scrape search results (sorted by seeders) and parse magnet URIs.
// ─────────────────────────────────────────────────────────────

async function searchTGX(query) {
    // cat=48 is TGX's XXX/adult category; sort by seeders descending
    const headers = {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
    };

    let html = null;
    // Try each mirror with a short timeout; bail as soon as one responds
    for (const mirror of TGX_MIRRORS) {
        try {
            const url = `${mirror}?search=${encodeURIComponent(query)}&cat=48&sort=seeders&order=desc`;
            const res = await axios.get(url, { timeout: TGX_MIRROR_TIMEOUT, headers });
            if (res.status === 200 && typeof res.data === 'string' && res.data.length > 500) {
                html = res.data;
                break;
            }
        } catch {
            // Mirror unreachable — try next one silently
        }
    }

    if (!html) {
        // All mirrors down — return empty silently (won't block TPB results)
        return [];
    }

    const $ = cheerio.load(html);
    const torrents = [];

    $('div.tgxtablerow').each((_i, row) => {
        const name    = $(row).find('a.txlight').first().text().trim();
        const magnet  = $(row).find('a[href^="magnet:"]').first().attr('href') || '';
        const seeders = parseInt($(row).find('span.badge-success').first().text().trim(), 10) || 0;
        const rawSize = $(row).find('span.badge-info').first().text().trim();

        if (!magnet || !name) return;

        const hashMatch = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
        if (!hashMatch) return;

        let sizeBytes = 0;
        if (rawSize) {
            const parts = rawSize.split(' ');
            const n = parseFloat(parts[0]);
            if (parts[1] === 'GB')      sizeBytes = Math.round(n * 1_073_741_824);
            else if (parts[1] === 'MB') sizeBytes = Math.round(n * 1_048_576);
            else if (parts[1] === 'KB') sizeBytes = Math.round(n * 1_024);
        }

        torrents.push({
            info_hash: hashMatch[1].toLowerCase(),
            name, size: sizeBytes, seeders,
            num_files: 1, id: null, provider: 'TGX',
        });
    });

    console.log(`[Stashio|TGX] "${query}" → ${torrents.length} results`);
    return torrents;
}

// ─────────────────────────────────────────────────────────────
//  Orchestration: Parallel multi-provider search
// ─────────────────────────────────────────────────────────────

async function searchAllProviders(query) {
    console.log(`[Stashio|Streams] Searching: "${query}"`);
    const [tpb, tgx] = await Promise.all([searchTPB(query), searchTGX(query)]);

    // Merge — keep the entry with the most seeders per hash
    const seen = new Map();
    for (const t of [...tpb, ...tgx]) {
        const existing = seen.get(t.info_hash);
        if (!existing || t.seeders > existing.seeders) seen.set(t.info_hash, t);
    }

    return [...seen.values()].sort((a, b) => b.seeders - a.seeders);
}

/**
 * Iterates the query matrix until we have enough results or run out of queries.
 */
export async function fetchExternalStreams(queries, maxResults = 8) {
    const globalSeen = new Set();
    const results    = [];

    for (const query of queries) {
        if (results.length >= maxResults) break;
        const found = await searchAllProviders(query);
        for (const t of found) {
            if (globalSeen.has(t.info_hash)) continue;
            globalSeen.add(t.info_hash);
            results.push(t);
        }
    }

    return results.sort((a, b) => b.seeders - a.seeders);
}

// ─────────────────────────────────────────────────────────────
//  Safety + Content Filtering
//  Inspired by Torrentio's stream validation approach:
//  - Reject archives, executables, and malware-signed file types
//  - For multi-file TPB torrents: audit the file list directly
//  - Require at least one recognised video file
// ─────────────────────────────────────────────────────────────

function isVideoFile(filename = '') {
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
}

const DANGEROUS_EXTENSIONS = new Set([
    '.exe', '.bat', '.cmd', '.vbs', '.scr', '.pif',
    '.msi', '.jar', '.ps1', '.zip', '.rar', '.7z', '.lnk',
]);

function isSafeTorrent(files) {
    for (const { name } of files) {
        const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
        if (DANGEROUS_EXTENSIONS.has(ext)) return false;
    }
    return true;
}

async function safetyCheck(torrent) {
    const name = (torrent.name ?? '').toLowerCase();

    // Quick reject: obvious non-video single-file torrents
    if (name.endsWith('.zip') || name.endsWith('.rar') || name.endsWith('.exe')) return false;

    // For TPB multi-file torrents: fetch and audit the actual file list
    if (torrent.provider === 'TPB' && torrent.id && parseInt(torrent.num_files, 10) > 1) {
        const files = await fetchTPBFiles(torrent.id);
        if (files.length > 0) {
            if (!isSafeTorrent(files)) {
                console.warn(`[Stashio|Safety] Rejected (dangerous file): "${torrent.name}"`);
                return false;
            }
            if (!files.some(f => isVideoFile(f.name))) {
                console.warn(`[Stashio|Safety] Rejected (no video file): "${torrent.name}"`);
                return false;
            }
        }
    }

    return true;
}

// ─────────────────────────────────────────────────────────────
//  File Index Resolution
// ─────────────────────────────────────────────────────────────

export async function resolveBestFileIdx(torrent) {
    if (parseInt(torrent.num_files ?? '1', 10) <= 1) return 0;
    if (torrent.provider !== 'TPB' || !torrent.id) return 0;

    const files = await fetchTPBFiles(torrent.id);
    if (!files.length) return 0;

    let bestIdx = 0, bestSize = -1;
    files.forEach(({ name, size }, idx) => {
        if (isVideoFile(name) && size > bestSize) { bestSize = size; bestIdx = idx; }
    });
    return bestIdx;
}

// ─────────────────────────────────────────────────────────────
//  Stremio Stream Object Formatting
// ─────────────────────────────────────────────────────────────

function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes > 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes > 1_048_576)     return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${bytes} B`;
}

function inferQuality(name = '') {
    const n = name.toUpperCase();
    if (n.includes('2160') || n.includes('4K') || n.includes('UHD')) return '4K';
    if (n.includes('1080'))                                           return '1080p';
    if (n.includes('720'))                                            return '720p';
    if (n.includes('480'))                                            return '480p';
    return 'SD';
}

export function mapToStremioStream(torrent, fileIdx = 0) {
    return {
        infoHash: torrent.info_hash,
        fileIdx,
        name:  `Stashio | ${torrent.provider}`,
        title: [
            `${inferQuality(torrent.name)}${torrent.size ? ` | 💾 ${formatSize(torrent.size)}` : ''}`,
            `👤 ${torrent.seeders || 0} seeders | ⚙️ ${torrent.provider}`,
            torrent.name,
        ].join('\n'),
        behaviorHints: { filename: torrent.name },
    };
}

// ─────────────────────────────────────────────────────────────
//  Public API: Full Resolution Pipeline
// ─────────────────────────────────────────────────────────────

export async function resolveStreams(queries) {
    const pipeline = async () => {
        const raw = await fetchExternalStreams(queries);
        console.log(`[Stashio|Streams] ${raw.length} raw result(s) before safety check`);

        const safeResults = await Promise.all(
            raw.map(async t => ({ torrent: t, safe: await safetyCheck(t) }))
        );
        const filtered = safeResults.filter(r => r.safe).map(r => r.torrent);

        if (!filtered.length) {
            console.log('[Stashio|Streams] No streams passed safety filter.');
            return [];
        }

        const streams = await Promise.all(
            filtered.map(async t => mapToStremioStream(t, await resolveBestFileIdx(t)))
        );

        console.log(`[Stashio|Streams] Resolved ${streams.length} safe stream(s).`);
        return streams;
    };

    const timeout = new Promise(resolve => setTimeout(() => {
        console.warn('[Stashio|Streams] Hard timeout — returning []');
        resolve([]);
    }, TOTAL_TIMEOUT_MS));

    return Promise.race([pipeline(), timeout]);
}
