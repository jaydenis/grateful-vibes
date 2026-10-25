/**
 * Offline copies of favorited shows, stored with the Cache Storage API.
 *
 * There is no service worker and no filesystem plugin: each show gets one cache
 * named after its identifier, audio bytes are stored under their original
 * Archive.org URL, and playback swaps a cached response for a blob object URL.
 * That keeps the player untouched — it still receives plain `{ url }` tracks.
 *
 * Every entry point is best-effort. A missing Cache Storage implementation
 * (older webview, private window) or a refused write must degrade to "stream it
 * instead" rather than breaking the page.
 */

const CACHE_PREFIX = 'grateful-vibes:offline:v1:';
const CACHE_NAMESPACE = 'grateful-vibes:offline:';

/** showId -> Map<remote url, object URL>, so re-selecting a track reuses its blob. */
const objectUrlsByShow = new Map();

function normalizeId(showId) {
  return typeof showId === 'string' ? showId.trim() : '';
}

function cacheName(showId) {
  return `${CACHE_PREFIX}${showId}`;
}

function hasCacheStorage() {
  try {
    return typeof caches !== 'undefined' && typeof caches.open === 'function';
  } catch {
    return false;
  }
}

function abortError() {
  const error = new Error('The download was cancelled.');
  error.name = 'AbortError';
  return error;
}

function isQuotaError(error) {
  return error?.name === 'QuotaExceededError' || error?.code === 22;
}

export function isSupported() {
  return hasCacheStorage();
}

/**
 * Download every playable track of a show into its own cache.
 *
 * Per-track failures are collected instead of thrown so one restricted file
 * cannot throw away the rest of the download. Whole-operation failures
 * (storage blocked, quota exhausted) surface as readable errors for the caller.
 *
 * @returns {Promise<{state: 'saved'|'partial'|'failed', tracks: object[], bytes: number, failed: object[]}>}
 */
export async function cacheShow(showId, tracks, { signal, onProgress } = {}) {
  const id = normalizeId(showId);
  if (!id) throw new Error('A show id is required to save offline audio.');

  const list = (Array.isArray(tracks) ? tracks : []).filter(
    (track) => track?.url && !track.unavailable,
  );
  if (!list.length) throw new Error('This recording has no tracks to save.');

  if (!hasCacheStorage()) {
    const error = new Error('Offline copies are unavailable on this device.');
    error.code = 'unsupported';
    throw error;
  }

  let cache;
  try {
    cache = await caches.open(cacheName(id));
  } catch {
    const error = new Error('This device blocked the offline cache.');
    error.code = 'blocked';
    throw error;
  }

  const saved = [];
  const failed = [];
  let bytes = 0;

  for (const track of list) {
    if (signal?.aborted) throw abortError();

    try {
      const response = await fetch(track.url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Measure the body before put() consumes it.
      const blob = await response.clone().blob();
      await cache.put(track.url, response);
      bytes += blob.size;
      saved.push({
        id: track.id,
        url: track.url,
        title: track.title,
        duration: track.duration ?? null,
        number: track.number ?? 0,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (isQuotaError(error)) throw new Error('Not enough space to save this show.');
      failed.push({
        id: track.id,
        title: track.title,
        message: error?.message ?? 'Download failed.',
      });
    }

    onProgress?.({ done: saved.length + failed.length, total: list.length, bytes, failed: failed.length });
  }

  const state = failed.length === 0 ? 'saved' : saved.length ? 'partial' : 'failed';
  return { state, tracks: saved, bytes, failed };
}

/**
 * Swap cached responses for blob URLs. Tracks that are not (or no longer) cached
 * keep their remote URL, so a partly saved show still plays like before.
 *
 * @returns {Promise<{tracks: object[], cached: number, missing: number, supported: boolean}>}
 */
export async function resolveTracks(showId, tracks) {
  const id = normalizeId(showId);
  const list = Array.isArray(tracks) ? tracks : [];
  const supported = hasCacheStorage();
  if (!id || !list.length || !supported) {
    return { tracks: list, cached: 0, missing: list.length, supported };
  }

  let cache;
  try {
    cache = await caches.open(cacheName(id));
  } catch {
    return { tracks: list, cached: 0, missing: list.length, supported: false };
  }

  const urls = objectUrlsByShow.get(id) ?? new Map();
  const resolved = [];
  let cached = 0;

  for (const track of list) {
    if (!track?.url) {
      resolved.push(track);
      continue;
    }

    let objectUrl = urls.get(track.url);
    if (!objectUrl) {
      try {
        const match = await cache.match(track.url);
        if (match) {
          objectUrl = URL.createObjectURL(await match.blob());
          urls.set(track.url, objectUrl);
        }
      } catch {
        /* Treat an unreadable entry as uncached; streaming still works. */
      }
    }

    if (objectUrl) {
      cached += 1;
      resolved.push({ ...track, remoteUrl: track.url, url: objectUrl, offline: true });
    } else {
      resolved.push({ ...track, remoteUrl: track.remoteUrl ?? track.url });
    }
  }

  if (cache) objectUrlsByShow.set(id, urls);
  return { tracks: resolved, cached, missing: list.length - cached, supported: true };
}

/** Delete one show's cached audio. Returns false when there was nothing to delete. */
export async function removeCachedShow(showId) {
  const id = normalizeId(showId);
  if (!id || !hasCacheStorage()) return false;
  try {
    return await caches.delete(cacheName(id));
  } catch {
    return false;
  }
}

/** Ids of every show with a cache on this device. */
export async function listCachedShowIds() {
  if (!hasCacheStorage()) return [];
  try {
    const names = await caches.keys();
    return names
      .filter((name) => name.startsWith(CACHE_PREFIX))
      .map((name) => name.slice(CACHE_PREFIX.length));
  } catch {
    return [];
  }
}

/** Drop every offline copy, including any left behind by an older prefix. */
export async function clearAllOffline() {
  if (!hasCacheStorage()) return;
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_NAMESPACE))
        .map((name) => caches.delete(name)),
    );
  } catch {
    /* Storage is unavailable; there is nothing else to clear. */
  }
  releaseAllUrls();
}

/**
 * Release the blob URLs issued for a show. Callers must not release a show that
 * is still loaded in the player: revoking an object URL that is playing stops it.
 */
export function releaseShowUrls(showId) {
  const id = normalizeId(showId);
  const urls = objectUrlsByShow.get(id);
  if (!urls) return;
  for (const objectUrl of urls.values()) {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      /* Already revoked or unsupported; nothing to clean up. */
    }
  }
  objectUrlsByShow.delete(id);
}

export function releaseAllUrls() {
  for (const showId of [...objectUrlsByShow.keys()]) releaseShowUrls(showId);
}
