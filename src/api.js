const SEARCH_ENDPOINT = 'https://archive.org/advancedsearch.php';
const METADATA_ENDPOINT = 'https://archive.org/metadata/';
const DOWNLOAD_ENDPOINT = 'https://archive.org/download/';
const RELISTEN_API = 'https://api.relisten.net/api';
const RELISTEN_ARTIST = 'grateful-dead';

/** Grateful Dead collection, restricted to stream-only recordings. */
export const COLLECTION_QUERY = 'collection:(GratefulDead AND stream_only)';
const MAX_ROWS = 10000;
const MAX_PAGES = 20;

const SEARCH_FIELDS = ['identifier', 'date', 'title', 'venue', 'coverage', 'downloads'];

/** Derive an Archive date string (YYYY-MM-DD) from a search hit. */
function normalizeDate(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function firstString(value) {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return String(value ?? '').trim();
}

/** "The Grateful Dead Live at Soldier Field on 1995-07-09" -> "Soldier Field" */
function cleanTitle(value) {
  return firstString(value)
    .replace(/^(the\s+)?grateful dead\s+live at\s+/i, '')
    .replace(/\s+on\s+\d{4}-\d{2}-\d{2}\s*$/i, '')
    .trim();
}

/**
 * Pull the recording type out of an identifier such as
 * `gd1995-07-09.sbd.miller.114369.flac16`.
 */
function sourceTag(identifier) {
  const match = String(identifier).match(/(?:^|[.\-_])(sbd|aud|mtx|matrix|fm|prefm|sbd\d*)(?:[.\-_]|$)/i);
  if (!match) return '';
  const tag = match[1].toLowerCase();
  if (tag.startsWith('sbd')) return 'SBD';
  if (tag.startsWith('prefm')) return 'FM';
  if (tag === 'matrix' || tag === 'mtx') return 'MTX';
  return tag.toUpperCase();
}

function normalizeShow(doc) {
  const id = firstString(doc.identifier);
  const venue = firstString(doc.venue);
  const title = cleanTitle(doc.title) || venue || 'Untitled recording';
  return {
    id,
    date: normalizeDate(doc.date),
    title,
    venue,
    coverage: firstString(doc.coverage),
    views: Number(doc.downloads) || 0,
    source: sourceTag(id),
    detailsUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
  };
}

async function fetchPage(page, { signal } = {}) {
  const params = new URLSearchParams({
    q: COLLECTION_QUERY,
    rows: String(MAX_ROWS),
    page: String(page),
    output: 'json',
  });
  for (const field of SEARCH_FIELDS) params.append('fl[]', field);
  params.append('sort[]', 'date desc');

  const response = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Archive.org search failed (HTTP ${response.status}).`);
  }

  const payload = await response.json();
  const docs = payload?.response?.docs ?? [];
  const numFound = Number(payload?.response?.numFound) || 0;
  const shows = docs.map(normalizeShow).filter((show) => show.id);
  return { shows, numFound };
}

/**
 * The same concert usually exists as several recordings (soundboard, audience,
 * matrix) and the venue text differs between them ("Riverport Amphitheatre"
 * vs "Riverport Amphitheater"), so group by date alone and keep the single
 * most-viewed item for that night.
 */
export function dedupeShows(shows) {
  const bestByConcert = new Map();

  for (const show of shows) {
    const key = show.date ?? `item:${show.id}`;
    const current = bestByConcert.get(key);
    if (!current || show.views > current.views) bestByConcert.set(key, show);
  }

  return [...bestByConcert.values()].sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return b.views - a.views;
  });
}

/**
 * Fetch every stream-only recording once, then dedupe it. The catalog is small
 * enough (~7k items, ~1.7 MB) that a single request beats page-by-page merging,
 * which could split a concert across a page boundary.
 *
 * @returns {Promise<{shows: object[], total: number, recordings: number}>}
 */
export async function fetchCatalog({ signal } = {}) {
  const collected = [];
  let numFound = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { shows, numFound: found } = await fetchPage(page, { signal });
    numFound = found;
    collected.push(...shows);
    if (shows.length < MAX_ROWS || collected.length >= numFound) break;
  }

  const shows = dedupeShows(collected);
  return { shows, total: shows.length, recordings: collected.length };
}

/** "07:31" -> 451 ; "451.53" -> 452 */
function parseLength(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.includes(':')) {
    const parts = raw.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

function fileUrl(identifier, name) {
  const encodedPath = name.split('/').map(encodeURIComponent).join('/');
  return `${DOWNLOAD_ENDPOINT}${encodeURIComponent(identifier)}/${encodedPath}`;
}

function humanizeFile(name) {
  const base = name.split('/').pop().replace(/\.[a-z0-9]+$/i, '');
  return base.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled track';
}

function trackFileNumber(file) {
  const fromTrack = Number.parseInt(file.track, 10);
  if (Number.isFinite(fromTrack)) return fromTrack;
  const fromName = file.name.match(/t(\d+)/i);
  return fromName ? Number.parseInt(fromName[1], 10) : 0;
}

function pickAudioFiles(files) {
  const playable = files.filter((file) => file.name && file.private !== 'true');
  const byFormat = (format) => playable.filter((file) => file.format === format);

  // Prefer VBR MP3 derivatives, then 128Kbps MP3, then Ogg for browsers that support it.
  for (const format of ['VBR MP3', 'MP3', 'Ogg Vorbis']) {
    const matches = byFormat(format);
    if (matches.length) return matches;
  }
  return [];
}

/**
 * Relisten keeps a normalized, artist-wide songbook. Several slugs can share
 * one display name ("Dark Star" exists three times upstream), so collapse them
 * by name and keep every variant slug for the performance lookup.
 *
 * @returns {Promise<{key: string, label: string, count: number, countLabel: string, slugs: string[]}[]>}
 */
export async function fetchSongbook({ signal } = {}) {
  const response = await fetch(`${RELISTEN_API}/v2/artists/${RELISTEN_ARTIST}/songs`, { signal });
  if (!response.ok) {
    throw new Error(`Could not load the songbook (HTTP ${response.status}).`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('The songbook returned an unexpected response.');
  }

  const byName = new Map();
  for (const raw of data) {
    const slug = String(raw?.slug ?? '').trim();
    const name = String(raw?.name ?? '').trim();
    if (!slug || !name) continue;

    const played = Number(raw?.shows_played_at) || 0;
    const nameKey = name.toLowerCase();
    let song = byName.get(nameKey);
    if (!song) {
      song = { label: name, variants: [] };
      byName.set(nameKey, song);
    }
    song.variants.push({ slug, played });
  }

  const songs = [];
  for (const song of byName.values()) {
    song.variants.sort((a, b) => b.played - a.played || a.slug.localeCompare(b.slug));
    const slugs = song.variants.filter((variant) => variant.played > 0).map((variant) => variant.slug);
    if (!slugs.length) continue;

    songs.push({
      key: song.variants[0].slug,
      label: song.label,
      // Variant slugs usually repeat the canonical history rather than add to it,
      // so the largest count is the closest estimate of unique shows.
      count: song.variants[0].played,
      countLabel: 'shows',
      slugs,
    });
  }

  return songs.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
}

/**
 * Every show Relisten has for one song slug. Dates are normalized so they can
 * be matched against the Archive catalog's one-recording-per-night entries.
 *
 * @returns {Promise<{name: string, shows: {date: string, venue: string, location: string}[]}>}
 */
export async function fetchSongShows(slug, { signal } = {}) {
  const response = await fetch(
    `${RELISTEN_API}/v3/artists/${RELISTEN_ARTIST}/songs/${encodeURIComponent(slug)}`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(`Could not load this song's history (HTTP ${response.status}).`);
  }

  const data = await response.json();
  const rows = Array.isArray(data?.shows) ? data.shows : [];
  const shows = rows
    .map((row) => {
      const date = normalizeDate(row?.display_date ?? row?.date);
      if (!date) return null;
      return {
        date,
        venue: String(row?.venue?.name ?? '').trim(),
        location: String(row?.venue?.location ?? '').trim(),
      };
    })
    .filter(Boolean);

  return { name: String(data?.name ?? '').trim(), shows };
}

/**
 * Fetch the playable tracks of one concert.
 * @returns {Promise<{identifier: string, tracks: object[]}>}
 */
export async function fetchShowTracks(identifier, { signal } = {}) {
  const response = await fetch(`${METADATA_ENDPOINT}${encodeURIComponent(identifier)}`, { signal });
  if (!response.ok) {
    throw new Error(`Could not load this recording (HTTP ${response.status}).`);
  }

  const data = await response.json();
  if (data?.is_dark) {
    throw new Error('This recording is no longer available on Archive.org.');
  }

  const files = Array.isArray(data?.files) ? data.files : [];
  const audioFiles = pickAudioFiles(files);
  if (!audioFiles.length) {
    throw new Error('Archive.org has no streamable audio files for this recording.');
  }

  audioFiles.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) ||
      trackFileNumber(a) - trackFileNumber(b),
  );

  const tracks = audioFiles.map((file, index) => ({
    id: `${identifier}:${file.name}`,
    url: fileUrl(identifier, file.name),
    title: String(file.title ?? '').trim() || humanizeFile(file.name),
    duration: parseLength(file.length),
    number: index + 1,
  }));

  return { identifier, tracks };
}
