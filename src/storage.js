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
};

const DEFAULT_VOLUME = 0.85;
const MAX_RECENT = 6;
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

/** Remove every piece of data this app has persisted (settings, session, recents). */
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
