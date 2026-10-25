import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecentShow,
  clearAllData,
  clearFavorites,
  clearRecentShows,
  loadFavorites,
  loadRecentShows,
  loadSession,
  removeFavorite,
  saveFavorite,
  saveSession,
  updateFavoriteCache,
} from '../src/storage.js';

const FAVORITES_KEY = 'grateful-vibes:v1:favorites';

function makeShow(id, extra = {}) {
  return {
    id,
    date: '1995-07-09',
    title: `Soldier Field ${id}`,
    venue: 'Soldier Field',
    coverage: 'Chicago, IL',
    source: 'SBD',
    detailsUrl: `https://archive.org/details/${id}`,
    views: 1234,
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('favorites persistence', () => {
  it('adds a favorite with the catalog fields needed to render it', () => {
    const result = saveFavorite(makeShow('gd1995-07-09.sbd.miller'));

    expect(result.ok).toBe(true);
    expect(result.favorites).toHaveLength(1);
    expect(loadFavorites()).toEqual([
      expect.objectContaining({
        id: 'gd1995-07-09.sbd.miller',
        title: 'Soldier Field gd1995-07-09.sbd.miller',
        date: '1995-07-09',
        venue: 'Soldier Field',
        coverage: 'Chicago, IL',
        source: 'SBD',
        detailsUrl: 'https://archive.org/details/gd1995-07-09.sbd.miller',
      }),
    ]);
  });

  it('keeps one entry per show and puts the newest first', () => {
    saveFavorite(makeShow('show-a'));
    saveFavorite(makeShow('show-b'));
    const duplicate = saveFavorite(makeShow('show-a'));

    expect(duplicate.favorites).toHaveLength(2);
    expect(loadFavorites().map((entry) => entry.id)).toEqual(['show-b', 'show-a']);
  });

  it('removes a favorite and reports when there was nothing to remove', () => {
    saveFavorite(makeShow('show-a'));
    saveFavorite(makeShow('show-b'));

    const removed = removeFavorite('show-a');
    expect(removed.removed).toBe(true);
    expect(removed.favorites.map((entry) => entry.id)).toEqual(['show-b']);
    expect(loadFavorites().map((entry) => entry.id)).toEqual(['show-b']);

    const missing = removeFavorite('show-a');
    expect(missing.removed).toBe(false);
    expect(missing.favorites).toHaveLength(1);
  });

  it('caps the list so localStorage stays small', () => {
    for (let index = 0; index < 32; index += 1) saveFavorite(makeShow(`show-${index}`));

    expect(loadFavorites()).toHaveLength(25);
    expect(loadFavorites()[0].id).toBe('show-31');
  });

  it('records the offline manifest and cache summary for one favorite only', () => {
    saveFavorite(makeShow('show-a'));
    saveFavorite(makeShow('show-b'));

    const result = updateFavoriteCache(
      'show-a',
      { state: 'saved', tracks: 1, bytes: 2048, savedAt: 1700000000000 },
      [
        { id: 'track-1', url: 'https://archive.org/download/a/t1.mp3', title: 'Jack Straw', duration: 401, number: 1 },
        { id: 'track-bad', url: 'file:///private/t2.mp3', title: 'Nope', duration: 10, number: 2 },
      ],
    );

    expect(result.ok).toBe(true);
    const saved = loadFavorites().find((entry) => entry.id === 'show-a');
    const untouched = loadFavorites().find((entry) => entry.id === 'show-b');
    expect(saved.cache).toEqual({ state: 'saved', tracks: 1, bytes: 2048, savedAt: 1700000000000 });
    // A manifest without a streamable URL is dropped instead of kept unplayable.
    expect(saved.tracks).toHaveLength(1);
    expect(saved.tracks[0].id).toBe('track-1');
    expect(untouched.cache).toBeNull();
    expect(untouched.tracks).toBeNull();
  });
});

describe('favorites invalid input', () => {
  it('rejects shows without a usable id and leaves storage untouched', () => {
    expect(saveFavorite(null).ok).toBe(false);
    expect(saveFavorite(undefined).ok).toBe(false);
    expect(saveFavorite({}).ok).toBe(false);
    expect(saveFavorite({ id: '' }).ok).toBe(false);
    expect(saveFavorite({ id: 42 }).ok).toBe(false);
    expect(saveFavorite({ id: '   ' }).ok).toBe(false);
    expect(loadFavorites()).toEqual([]);
  });

  it('rejects invalid ids for removal and cache updates', () => {
    saveFavorite(makeShow('show-a'));

    expect(removeFavorite(null)).toEqual({ ok: false, favorites: expect.any(Array), removed: false });
    expect(updateFavoriteCache('', { state: 'saved' }).ok).toBe(false);
    expect(updateFavoriteCache('missing-show', { state: 'saved' }).ok).toBe(false);
    expect(loadFavorites()).toHaveLength(1);
  });

  it('ignores corrupted or partially shaped stored data', () => {
    window.localStorage.setItem(FAVORITES_KEY, '{not json');
    expect(loadFavorites()).toEqual([]);

    window.localStorage.setItem(
      FAVORITES_KEY,
      JSON.stringify([
        { id: 'ok-show', title: 'Kept' },
        { title: 'No id' },
        null,
        { id: 'bad-cache', cache: { state: 'nonsense', tracks: 'x' }, tracks: 'nope' },
      ]),
    );

    expect(loadFavorites().map((entry) => entry.id)).toEqual(['ok-show', 'bad-cache']);
    expect(loadFavorites()[1].cache.state).toBe('failed');
    expect(loadFavorites()[1].tracks).toBeNull();
  });
});

describe('favorites permission failure', () => {
  it('reports a blocked write instead of throwing', () => {
    const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });

    const result = saveFavorite(makeShow('show-a'));

    expect(denied).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    // The caller keeps its in-memory copy for this session, but nothing persisted.
    expect(result.favorites).toHaveLength(1);
    expect(loadFavorites()).toEqual([]);
  });

  it('still removes a favorite from memory when the delete cannot be written', () => {
    saveFavorite(makeShow('show-a'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });

    const result = removeFavorite('show-a');
    expect(result.removed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.favorites).toEqual([]);
  });
});

describe('favorites regression', () => {
  it('does not disturb session, recents, or settings', () => {
    saveSession({
      showId: 'show-a',
      showTitle: 'A',
      showDate: '1995-07-09',
      trackId: 'track-1',
      trackIndex: 0,
      trackTitle: 'Jack Straw',
      time: 42,
    });
    addRecentShow(makeShow('show-b'));

    saveFavorite(makeShow('show-a'));
    saveFavorite(makeShow('show-b'));
    removeFavorite('show-a');
    updateFavoriteCache('show-b', { state: 'saved', tracks: 1, bytes: 10, savedAt: 1 });

    expect(loadSession()).toEqual(
      expect.objectContaining({ showId: 'show-a', trackId: 'track-1', time: 42 }),
    );
    expect(loadRecentShows().map((entry) => entry.id)).toEqual(['show-b']);
  });

  it('clears favorites without touching recents, and clearAllData clears both', () => {
    addRecentShow(makeShow('show-a'));
    saveFavorite(makeShow('show-b'));

    clearFavorites();
    expect(loadFavorites()).toEqual([]);
    expect(loadRecentShows()).toHaveLength(1);

    saveFavorite(makeShow('show-b'));
    clearAllData();
    expect(loadFavorites()).toEqual([]);
    expect(loadRecentShows()).toEqual([]);
  });

  it('keeps favorites when recents are cleared', () => {
    addRecentShow(makeShow('show-a'));
    saveFavorite(makeShow('show-b'));

    clearRecentShows();

    expect(loadRecentShows()).toEqual([]);
    expect(loadFavorites().map((entry) => entry.id)).toEqual(['show-b']);
  });

  it('keys favorites inside the versioned namespace so reset data finds them', () => {
    saveFavorite(makeShow('show-a'));
    const keys = Object.keys(window.localStorage);
    expect(keys).toContain(FAVORITES_KEY);
    expect(keys.every((key) => key.startsWith('grateful-vibes:'))).toBe(true);
  });
});
