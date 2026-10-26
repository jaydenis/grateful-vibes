/**
 * Boots the real app in jsdom against a mocked catalog. These are the acceptance
 * tests: the sidebar entry, the row star, the panel star, the URL state, and the
 * blocked-storage warning all have to work through the actual DOM wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchCatalog: vi.fn(),
  fetchShowTracks: vi.fn(),
  fetchSongbook: vi.fn(),
  fetchSongShows: vi.fn(),
}));

vi.mock('../src/api.js', () => api);
vi.mock('@tauri-apps/api/app', () => ({ exit: vi.fn(), onBackButtonPress: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => false),
  isTauri: () => false,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: vi.fn() }),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const FAVORITES_KEY = 'grateful-vibes:v1:favorites';
// jsdom runs modules from an http URL, so the fixture comes off the working directory.
const BODY = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8').match(
  /<body[^>]*>([\s\S]*)<\/body>/i,
)[1];

const SHOWS = [
  {
    id: 'show-a',
    date: '1995-07-09',
    title: 'Soldier Field',
    venue: 'Soldier Field',
    coverage: 'Chicago, IL',
    source: 'SBD',
    views: 12000,
    detailsUrl: 'https://archive.org/details/show-a',
  },
  {
    id: 'show-b',
    date: '1977-05-08',
    title: 'Barton Hall',
    venue: 'Barton Hall',
    coverage: 'Ithaca, NY',
    source: 'AUD',
    views: 9000,
    detailsUrl: 'https://archive.org/details/show-b',
  },
];

const TRACKS = [
  {
    id: 'show-a:t1.mp3',
    url: 'https://archive.org/download/show-a/t1.mp3',
    title: 'Jack Straw',
    duration: 300,
    number: 1,
  },
  {
    id: 'show-a:t2.mp3',
    url: 'https://archive.org/download/show-a/t2.mp3',
    title: 'Sugaree',
    duration: 400,
    number: 2,
  },
];

function readFavorites() {
  return JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? '[]');
}

/** A favorite that already has a saved setlist, as a previous download would leave it. */
function seedSavedFavorite() {
  window.localStorage.setItem(
    FAVORITES_KEY,
    JSON.stringify([
      {
        ...SHOWS[0],
        addedAt: 1,
        cache: { state: 'saved', tracks: TRACKS.length, bytes: 64, savedAt: 1 },
        tracks: TRACKS,
      },
    ]),
  );
}

/** A favorite whose last download failed, with the setlist still on the device. */
function seedFailedFavorite() {
  window.localStorage.setItem(
    FAVORITES_KEY,
    JSON.stringify([
      {
        ...SHOWS[0],
        addedAt: 1,
        cache: { state: 'failed', tracks: 0, bytes: 0, savedAt: 1 },
        tracks: TRACKS,
      },
    ]),
  );
}

/**
 * Hand out one release per Archive.org request so a test can stop the download
 * between tracks and read the row while it is genuinely in progress.
 */
function gateFetch() {
  const releases = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(new Response('audio-bytes', { status: 200 })));
        }),
    ),
  );
  return releases;
}

/** Cache Storage holding the saved tracks for show-a. */
function seedCacheStorage() {
  const entries = new Map(TRACKS.map((track) => [track.url, new Response('audio-bytes')]));
  globalThis.caches = {
    open: vi.fn(async () => ({
      match: vi.fn(async (url) => entries.get(url)),
      put: vi.fn(),
    })),
    keys: vi.fn(async () => [`grateful-vibes:offline:v1:show-a`]),
    delete: vi.fn(async () => true),
  };
}

async function boot({
  query = '',
  storageBlocked = false,
  catalogFailure = false,
  tracksFailure = false,
} = {}) {
  document.body.innerHTML = BODY;
  window.history.replaceState(null, '', `/${query}`);

  if (catalogFailure) {
    api.fetchCatalog.mockRejectedValue(new Error('Could not reach Archive.org.'));
  } else {
    api.fetchCatalog.mockResolvedValue({
      shows: SHOWS,
      total: SHOWS.length,
      recordings: SHOWS.length,
    });
  }

  if (tracksFailure) {
    api.fetchShowTracks.mockRejectedValue(new Error('Could not load this recording (HTTP 503).'));
  } else {
    api.fetchShowTracks.mockResolvedValue({ identifier: 'show-a', tracks: TRACKS });
  }

  if (storageBlocked) {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });
  }

  vi.resetModules();
  await import('../src/main.js');

  if (query.includes('favorites=1')) {
    await vi.waitFor(() => {
      expect(document.getElementById('drill-title').textContent).toBe('Favorites');
    });
    return;
  }

  if (catalogFailure) {
    await vi.waitFor(() => {
      expect(document.getElementById('list-alert').hidden).toBe(false);
    });
    return;
  }

  await vi.waitFor(() => {
    expect(document.querySelectorAll('#show-list .show').length).toBe(SHOWS.length);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('favorites UI', () => {
  it('opens the favorites view from the sidebar menu item', async () => {
    await boot();

    const item = document.getElementById('favorites-open');
    expect(item.getAttribute('aria-pressed')).toBe('false');

    item.click();

    expect(document.getElementById('drill-title').textContent).toBe('Favorites');
    expect(document.getElementById('show-list').textContent).toContain('No favorites yet');
    expect(document.getElementById('show-list').hidden).toBe(false);
    expect(item.getAttribute('aria-pressed')).toBe('true');
    expect(window.location.search).toBe('?favorites=1');
  });

  it('adds and removes a favorite from a show row', async () => {
    await boot();

    const star = document.querySelector('#show-list .show-fav');
    expect(star.getAttribute('aria-pressed')).toBe('false');
    expect(star.getAttribute('aria-label')).toBe('Add Soldier Field to favorites');

    star.click();

    await vi.waitFor(() => expect(readFavorites()).toHaveLength(1));
    expect(readFavorites()[0]).toEqual(
      expect.objectContaining({ id: 'show-a', title: 'Soldier Field', source: 'SBD' }),
    );
    expect(document.getElementById('favorites-count').textContent).toBe('1');
    expect(document.getElementById('favorites-count').hidden).toBe(false);
    expect(star.getAttribute('aria-pressed')).toBe('true');
    expect(star.getAttribute('aria-label')).toBe('Remove Soldier Field from favorites');

    // The added show is listed in the favorites view, and its star removes it there.
    document.getElementById('favorites-open').click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#show-list .show-item').length).toBe(1),
    );
    const favoriteStar = document.querySelector('#show-list .show-fav');
    expect(favoriteStar.getAttribute('aria-pressed')).toBe('true');

    favoriteStar.click();

    await vi.waitFor(() => expect(readFavorites()).toHaveLength(0));
    expect(document.getElementById('show-list').textContent).toContain('No favorites yet');
    expect(document.getElementById('favorites-count').hidden).toBe(true);
  });

  it('favorites the open show from the track panel', async () => {
    await boot();

    document.querySelector('#show-list .show').click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#track-list .track-button').length).toBe(2),
    );

    const panelStar = document.getElementById('panel-favorite');
    expect(panelStar.disabled).toBe(false);
    expect(panelStar.getAttribute('aria-pressed')).toBe('false');
    expect(panelStar.textContent.trim()).toBe('Favorite');

    panelStar.click();
    await vi.waitFor(() => expect(readFavorites()).toHaveLength(1));
    expect(panelStar.getAttribute('aria-pressed')).toBe('true');
    expect(panelStar.textContent.trim()).toBe('Favorited');

    panelStar.click();
    await vi.waitFor(() => expect(readFavorites()).toHaveLength(0));
    expect(panelStar.getAttribute('aria-pressed')).toBe('false');
    expect(panelStar.textContent.trim()).toBe('Favorite');
  });

  it('restores the favorites view from a shared link', async () => {
    await boot({ query: '?favorites=1' });

    expect(document.getElementById('drill-title').textContent).toBe('Favorites');
    expect(document.getElementById('show-list').hidden).toBe(false);
    expect(window.location.search).toBe('?favorites=1');
  });

  it('keeps the favorite for the session when storage is blocked', async () => {
    await boot({ storageBlocked: true });

    document.querySelector('#show-list .show-fav').click();

    await vi.waitFor(() => expect(document.getElementById('favorites-count').textContent).toBe('1'));
    expect(readFavorites()).toHaveLength(0);
    expect(document.getElementById('list-alert').hidden).toBe(false);
    expect(document.getElementById('list-alert-msg').textContent).toContain('blocking storage');
  });

  it('plays the saved copy when Archive.org is unreachable', async () => {
    seedSavedFavorite();
    seedCacheStorage();
    await boot({ tracksFailure: true });

    document.querySelector('#show-list .show').click();

    await vi.waitFor(() =>
      expect(document.querySelectorAll('#track-list .track-button').length).toBe(TRACKS.length),
    );
    expect(document.getElementById('panel-note').textContent).toContain('Playing the saved copy');
    // Cached tracks are handed to the player as blob URLs.
    expect(URL.createObjectURL).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.getElementById('np-track').textContent).toBe('Jack Straw'),
    );
  });

  it('lists favorites when the catalog cannot load', async () => {
    seedSavedFavorite();

    await boot({ query: '?favorites=1', catalogFailure: true });

    expect(document.getElementById('drill-title').textContent).toBe('Favorites');
    expect(document.querySelectorAll('#show-list .show-item').length).toBe(1);
    expect(document.getElementById('list-status').textContent).toContain('1 favorite');
    expect(document.getElementById('list-status').textContent).toContain('1 saved offline');
  });

  it('shows per-favorite download progress and hides retry while saving', async () => {
    seedFailedFavorite();
    seedCacheStorage();
    await boot({ query: '?favorites=1' });

    const badge = () => document.querySelector('#show-list .show-offline');
    const bar = () => document.querySelector('#show-list .show-progress');
    const retry = () => document.querySelector('#show-list .show-retry');

    expect(badge().textContent).toBe('Not saved offline');
    expect(retry().hidden).toBe(false);
    expect(bar().hidden).toBe(true);

    // jsdom has no real fetch, so each track waits until the test releases it.
    const releases = gateFetch();
    retry().click();

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(badge().textContent).toBe('Saving offline · 0/2 tracks');
    expect(document.getElementById('list-status').textContent).toContain('1 downloading');
    expect(bar().hidden).toBe(false);
    expect(bar().getAttribute('role')).toBe('progressbar');
    expect(bar().getAttribute('aria-valuemax')).toBe('2');
    expect(bar().getAttribute('aria-valuenow')).toBe('0');
    expect(retry().hidden).toBe(true);

    releases[0]();

    // One of two tracks is stored: the badge and the bar both move.
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(badge().textContent).toBe('Saving offline · 1/2 tracks');
    expect(bar().getAttribute('aria-valuenow')).toBe('1');
    expect(bar().querySelector('.show-progress-fill').style.width).toBe('50%');

    releases[1]();

    await vi.waitFor(() => expect(badge().textContent).toBe('Saved offline · 2 tracks'));
    expect(bar().hidden).toBe(true);
    expect(retry().hidden).toBe(true);
    expect(readFavorites()[0].cache).toEqual(
      expect.objectContaining({ state: 'saved', tracks: TRACKS.length }),
    );
  });

  it('keeps the retry control after a failed download', async () => {
    seedFailedFavorite();
    seedCacheStorage();
    await boot({ query: '?favorites=1' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    document.querySelector('#show-list .show-retry').click();

    await vi.waitFor(() =>
      expect(document.getElementById('list-alert-msg').textContent).toContain(
        'None of this show could be saved offline.',
      ),
    );
    expect(document.getElementById('list-alert').hidden).toBe(false);
    expect(document.querySelector('#show-list .show-offline').textContent).toBe('Not saved offline');
    expect(document.querySelector('#show-list .show-retry').hidden).toBe(false);
    expect(readFavorites()[0].cache.state).toBe('failed');
  });

  it('never offers retry for a finished copy', async () => {
    seedSavedFavorite();
    seedCacheStorage();
    await boot({ query: '?favorites=1' });

    expect(document.querySelector('#show-list .show-offline').textContent).toBe(
      'Saved offline · 2 tracks',
    );
    expect(document.querySelector('#show-list .show-retry').hidden).toBe(true);
    expect(document.querySelector('#show-list .show-progress').hidden).toBe(true);
  });

  it('leaves ordinary browsing untouched', async () => {
    await boot();

    expect(document.getElementById('favorites-count').hidden).toBe(true);
    expect(document.querySelectorAll('#show-list .show-item').length).toBe(2);
    expect(document.querySelectorAll('#show-list .show-fav').length).toBe(2);
    expect(document.querySelectorAll('#show-list .show-retry').length).toBe(0);
    expect(document.querySelectorAll('#show-list .show-progress').length).toBe(0);
    expect(window.location.search).toBe('');

    // A star click must not open the setlist.
    document.querySelector('#show-list .show-fav').click();
    await vi.waitFor(() => expect(readFavorites()).toHaveLength(1));
    expect(document.getElementById('panel-content').hidden).toBe(true);
  });
});
