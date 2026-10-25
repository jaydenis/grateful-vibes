/**
 * Local persistence for listening state. Everything here is best-effort:
 * private browsing, disabled storage, and corrupted values all degrade to
 * defaults instead of breaking the app.
 */

const VERSION = 1;
const PREFIX = `grateful-vibes:v${VERSION}`;
const KEYS = {
  settings: `${PREFIX}:settings`,
  session: `${PREFIX}:session`,
  recent: `${PREFIX}:recent`,
  favorites: `${PREFIX}:favorites`,
};

const DEFAULT_VOLUME = 0.85;
const MAX_RECENT = 6;
const MAX_FAVORITES = 25;
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 30;

function read(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* Storage is unavailable; nothing to clear. */
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampVolume(value) {
  return Math.min(Math.max(value, 0), 1);
}

export function loadSettings() {
  const data = read(KEYS.settings);
  const volume = Number(data?.volume);
  const theme = typeof data?.theme === 'string' && data.theme ? data.theme : null;
  return {
    volume: Number.isFinite(volume) ? clampVolume(volume) : DEFAULT_VOLUME,
    theme,
  };
}

export function saveSettings({ volume, theme } = {}) {
  const hasVolume = Number.isFinite(volume);
  const hasTheme = typeof theme === 'string' && theme.length > 0;
  if (!hasVolume && !hasTheme) return;

  const current = read(KEYS.settings);
  const next = { version: VERSION, ...(isRecord(current) ? current : {}) };
  if (hasVolume) next.volume = clampVolume(volume);
  if (hasTheme) next.theme = theme;
  write(KEYS.settings, next);
}

export function loadSession() {
  const data = read(KEYS.session);
  if (!isRecord(data) || data.version !== VERSION) return null;
  if (typeof data.showId !== 'string' || !data.showId) return null;
  if (typeof data.trackId !== 'string' || !data.trackId) return null;
  if (!Number.isFinite(data.time) || data.time < 0) return null;
  if (!Number.isFinite(data.updatedAt) || Date.now() - data.updatedAt > SESSION_MAX_AGE) {
    return null;
  }

  return {
    showId: data.showId,
    showTitle: typeof data.showTitle === 'string' ? data.showTitle : '',
    showDate: typeof data.showDate === 'string' ? data.showDate : null,
    trackId: data.trackId,
    trackIndex: Number.isInteger(data.trackIndex) ? data.trackIndex : 0,
    trackTitle: typeof data.trackTitle === 'string' ? data.trackTitle : '',
    time: data.time,
    updatedAt: data.updatedAt,
  };
}

export function saveSession(session) {
  if (!session?.showId || !session?.trackId) return;
  write(KEYS.session, { version: VERSION, ...session, updatedAt: Date.now() });
}

export function clearSession() {
  remove(KEYS.session);
}

export function loadRecentShows() {
  const data = read(KEYS.recent);
  if (!Array.isArray(data)) return [];

  return data
    .filter((entry) => isRecord(entry) && typeof entry.id === 'string' && entry.id)
    .slice(0, MAX_RECENT)
    .map((entry) => ({
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : '',
      date: typeof entry.date === 'string' ? entry.date : null,
      playedAt: Number(entry.playedAt) || 0,
    }));
}

/** Move a show to the front of the recent list and cap the list length. */
export function addRecentShow(show) {
  if (!show?.id) return loadRecentShows();

  const list = loadRecentShows().filter((entry) => entry.id !== show.id);
  list.unshift({
    id: show.id,
    title: show.title ?? '',
    date: show.date ?? null,
    playedAt: Date.now(),
  });

  const next = list.slice(0, MAX_RECENT);
  write(KEYS.recent, next);
  return next;
}

export function clearRecentShows() {
  remove(KEYS.recent);
}

/**
 * Favorites keep a small copy of the show's catalog fields plus the setlist that
 * was saved for offline play, so the favorites view and a saved show still work
 * when the catalog request fails.
 */
function normalizeFavoriteTrack(track) {
  if (!isRecord(track) || typeof track.id !== 'string' || !track.id) return null;
  const url = typeof track.url === 'string' ? track.url : '';
  // A manifest without a stream URL can never be played, even from the cache.
  if (!/^https?:\/\//i.test(url)) return null;
  const duration = Number(track.duration);
  return {
    id: track.id,
    url,
    title: typeof track.title === 'string' ? track.title : 'Untitled track',
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    number: Number.isInteger(track.number) ? track.number : 0,
  };
}

function normalizeFavoriteCache(cache) {
  if (!isRecord(cache)) return null;
  const state = ['saved', 'partial', 'failed'].includes(cache.state) ? cache.state : 'failed';
  return {
    state,
    tracks: Math.max(0, Math.round(Number(cache.tracks) || 0)),
    bytes: Math.max(0, Math.round(Number(cache.bytes) || 0)),
    savedAt: Number(cache.savedAt) || 0,
  };
}

function normalizeFavorite(entry) {
  if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) return null;
  const tracks = Array.isArray(entry.tracks)
    ? entry.tracks.map(normalizeFavoriteTrack).filter(Boolean)
    : [];
  return {
    id: entry.id,
    date: typeof entry.date === 'string' ? entry.date : null,
    title: typeof entry.title === 'string' ? entry.title : '',
    venue: typeof entry.venue === 'string' ? entry.venue : '',
    coverage: typeof entry.coverage === 'string' ? entry.coverage : '',
    source: typeof entry.source === 'string' ? entry.source : '',
    detailsUrl:
      typeof entry.detailsUrl === 'string' && entry.detailsUrl
        ? entry.detailsUrl
        : `https://archive.org/details/${encodeURIComponent(entry.id)}`,
    views: Number(entry.views) || 0,
    addedAt: Number(entry.addedAt) || 0,
    cache: normalizeFavoriteCache(entry.cache),
    tracks: tracks.length ? tracks : null,
  };
}

/** Newest favorite first, capped so localStorage stays small. */
export function loadFavorites() {
  const data = read(KEYS.favorites);
  if (!Array.isArray(data)) return [];

  return data
    .map(normalizeFavorite)
    .filter(Boolean)
    .slice(0, MAX_FAVORITES);
}

/**
 * Persist a show as a favorite. Returns `{ ok }` because a blocked write (private
 * browsing, full storage) must be surfaced rather than silently dropped.
 */
export function saveFavorite(show) {
  const id = typeof show?.id === 'string' ? show.id.trim() : '';
  const current = loadFavorites();
  if (!id) return { ok: false, favorites: current };
  if (current.some((entry) => entry.id === id)) return { ok: true, favorites: current };

  const entry = normalizeFavorite({
    ...show,
    id,
    addedAt: Date.now(),
    cache: null,
    tracks: null,
  });
  const next = [entry, ...current].slice(0, MAX_FAVORITES);
  return { ok: write(KEYS.favorites, next), favorites: next };
}

export function removeFavorite(id) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key) return { ok: false, favorites: loadFavorites(), removed: false };

  const current = loadFavorites();
  const next = current.filter((entry) => entry.id !== key);
  if (next.length === current.length) {
    return { ok: true, favorites: current, removed: false };
  }
  return { ok: write(KEYS.favorites, next), favorites: next, removed: true };
}

/** Record the result of a download without dropping the saved setlist on failure. */
export function updateFavoriteCache(id, cache, tracks) {
  const key = typeof id === 'string' ? id.trim() : '';
  const current = loadFavorites();
  if (!key) return { ok: false, favorites: current };

  const index = current.findIndex((entry) => entry.id === key);
  if (index < 0) return { ok: false, favorites: current };

  const savedTracks = Array.isArray(tracks)
    ? tracks.map(normalizeFavoriteTrack).filter(Boolean)
    : [];
  const entry = {
    ...current[index],
    cache: normalizeFavoriteCache(cache),
    tracks: savedTracks.length ? savedTracks : current[index].tracks,
  };
  const next = [...current];
  next[index] = entry;
  return { ok: write(KEYS.favorites, next), favorites: next };
}

export function clearFavorites() {
  remove(KEYS.favorites);
  return [];
}

/** Remove every piece of data this app has persisted (settings, session, recents, favorites). */
export function clearAllData() {
  for (const key of Object.values(KEYS)) remove(key);

  // Catch keys from any earlier prefix/version so a reset really starts over.
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith('grateful-vibes:')) remove(key);
    }
  } catch {
    /* Storage is unavailable; nothing else to clear. */
  }
}
