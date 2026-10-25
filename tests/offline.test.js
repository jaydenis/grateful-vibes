import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheShow,
  clearAllOffline,
  isSupported,
  listCachedShowIds,
  releaseAllUrls,
  releaseShowUrls,
  removeCachedShow,
  resolveTracks,
} from '../src/offline.js';

const SHOW = 'gd1995-07-09.sbd.miller';

function makeTracks(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${SHOW}:t${index + 1}.mp3`,
    url: `https://archive.org/download/${SHOW}/t${index + 1}.mp3`,
    title: `Song ${index + 1}`,
    duration: 240,
    number: index + 1,
  }));
}

/** Minimal in-memory Cache Storage: one Map of entries per cache name. */
function createCacheStorage({ failOpen = false, failPut = null } = {}) {
  const stores = new Map();

  function makeCache() {
    const entries = new Map();
    return {
      entries,
      put: vi.fn(async (url, response) => {
        if (failPut) throw failPut;
        entries.set(url, response);
      }),
      match: vi.fn(async (url) => entries.get(url)),
    };
  }

  return {
    stores,
    open: vi.fn(async (name) => {
      if (failOpen) throw new Error('Cache Storage is blocked');
      if (!stores.has(name)) stores.set(name, makeCache());
      return stores.get(name);
    }),
    delete: vi.fn(async (name) => stores.delete(name)),
    keys: vi.fn(async () => [...stores.keys()]),
  };
}

function okResponse(body = 'audio-bytes') {
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  globalThis.caches = createCacheStorage();
  vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
});

afterEach(() => {
  releaseAllUrls();
});

describe('offline cache happy path', () => {
  it('saves every playable track and reports progress', async () => {
    const onProgress = vi.fn();
    const result = await cacheShow(SHOW, makeTracks(3), { onProgress });

    expect(result.state).toBe('saved');
    expect(result.tracks).toHaveLength(3);
    expect(result.failed).toEqual([]);
    expect(result.bytes).toBeGreaterThan(0);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ done: 3, total: 3, failed: 0 }),
    );
    expect(globalThis.caches.stores.get(`grateful-vibes:offline:v1:${SHOW}`).entries.size).toBe(3);
  });

  it('resolves cached tracks to blob URLs and reuses them across calls', async () => {
    const tracks = makeTracks(2);
    await cacheShow(SHOW, tracks);

    const first = await resolveTracks(SHOW, tracks);
    const second = await resolveTracks(SHOW, tracks);

    expect(first.supported).toBe(true);
    expect(first.cached).toBe(2);
    expect(first.missing).toBe(0);
    expect(first.tracks.every((track) => track.offline)).toBe(true);
    expect(first.tracks[0].url).toMatch(/^blob:/);
    expect(first.tracks[0].remoteUrl).toBe(tracks[0].url);
    expect(second.tracks[0].url).toBe(first.tracks[0].url);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('deletes one show without touching another and lists saved shows', async () => {
    await cacheShow(SHOW, makeTracks(1));
    await cacheShow('other-show', [
      { id: 'other:t1', url: 'https://archive.org/download/other/t1.mp3', title: 'Other', duration: 1 },
    ]);

    expect((await listCachedShowIds()).sort()).toEqual(['gd1995-07-09.sbd.miller', 'other-show']);

    expect(await removeCachedShow(SHOW)).toBe(true);
    expect(await listCachedShowIds()).toEqual(['other-show']);
    expect(await removeCachedShow(SHOW)).toBe(false);
  });

  it('clears saved audio but leaves unrelated caches alone', async () => {
    const storage = globalThis.caches;
    storage.stores.set('unrelated-app-cache', { entries: new Map() });
    await cacheShow(SHOW, makeTracks(1));

    await clearAllOffline();

    expect(await listCachedShowIds()).toEqual([]);
    expect(storage.stores.has('unrelated-app-cache')).toBe(true);
  });
});

describe('offline dependency failure', () => {
  it('reports unsupported when the Cache API is absent and streams unchanged', async () => {
    delete globalThis.caches;

    expect(isSupported()).toBe(false);
    await expect(cacheShow(SHOW, makeTracks(1))).rejects.toMatchObject({ code: 'unsupported' });

    const tracks = makeTracks(2);
    const resolved = await resolveTracks(SHOW, tracks);
    expect(resolved).toEqual({ tracks, cached: 0, missing: 2, supported: false });
  });

  it('reports blocked storage when the cache cannot be opened', async () => {
    globalThis.caches = createCacheStorage({ failOpen: true });

    await expect(cacheShow(SHOW, makeTracks(1))).rejects.toMatchObject({ code: 'blocked' });
    const resolved = await resolveTracks(SHOW, makeTracks(1));
    expect(resolved.supported).toBe(false);
    expect(resolved.tracks[0].url).toMatch(/^https:/);
  });

  it('keeps the tracks it managed to save when one download fails', async () => {
    const tracks = makeTracks(2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => (url.endsWith('t1.mp3') ? okResponse() : new Response('', { status: 404 }))),
    );

    const result = await cacheShow(SHOW, tracks);

    expect(result.state).toBe('partial');
    expect(result.tracks).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].message).toContain('404');
  });

  it('surfaces a quota failure as a readable error', async () => {
    const quota = new Error('quota');
    quota.name = 'QuotaExceededError';
    globalThis.caches = createCacheStorage({ failPut: quota });

    await expect(cacheShow(SHOW, makeTracks(1))).rejects.toThrow(
      'Not enough space to save this show.',
    );
  });

  it('marks a show as failed when every track fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));

    const result = await cacheShow(SHOW, makeTracks(2));

    expect(result.state).toBe('failed');
    expect(result.tracks).toEqual([]);
    expect(result.failed).toHaveLength(2);
  });
});

describe('offline invalid input', () => {
  it('rejects a missing show id or an empty tracklist', async () => {
    await expect(cacheShow('', makeTracks(1))).rejects.toThrow('A show id is required');
    await expect(cacheShow('   ', makeTracks(1))).rejects.toThrow('A show id is required');
    await expect(cacheShow(SHOW, [])).rejects.toThrow('no tracks to save');
    await expect(cacheShow(SHOW, null)).rejects.toThrow('no tracks to save');
  });

  it('skips tracks without a URL and unavailable tracks', async () => {
    const result = await cacheShow(SHOW, [
      { id: 'no-url', title: 'Missing' },
      { id: 'unavailable', url: 'https://archive.org/download/x/y.mp3', unavailable: true },
      ...makeTracks(1),
    ]);

    expect(result.state).toBe('saved');
    expect(result.tracks).toHaveLength(1);
  });

  it('returns uncached tracks untouched for an unknown show', async () => {
    const tracks = makeTracks(2);
    const resolved = await resolveTracks('never-saved', tracks);

    expect(resolved.cached).toBe(0);
    expect(resolved.missing).toBe(2);
    expect(resolved.tracks.every((track) => !track.offline)).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('stops a cancelled download without caching the rest', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, { signal } = {}) => {
        controller.abort();
        if (signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        return okResponse();
      }),
    );

    await expect(
      cacheShow(SHOW, makeTracks(3), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('offline regression', () => {
  it('plays a show with no cache from Archive.org exactly as before', async () => {
    const tracks = makeTracks(2);
    const resolved = await resolveTracks(SHOW, tracks);

    expect(resolved.supported).toBe(true);
    expect(resolved.tracks.map((track) => track.url)).toEqual(tracks.map((track) => track.url));
    expect(resolved.tracks[0].remoteUrl).toBe(tracks[0].url);
  });

  it('falls back to the remote URL when a cached track disappears', async () => {
    const tracks = makeTracks(2);
    await cacheShow(SHOW, tracks);

    const cache = globalThis.caches.stores.get(`grateful-vibes:offline:v1:${SHOW}`);
    cache.entries.delete(tracks[0].url);

    const resolved = await resolveTracks(SHOW, tracks);
    expect(resolved.cached).toBe(1);
    expect(resolved.missing).toBe(1);
    expect(resolved.tracks[0].url).toBe(tracks[0].url);
    expect(resolved.tracks[1].url).toMatch(/^blob:/);
  });

  it('revokes blob URLs on release so a session cannot leak them', async () => {
    const tracks = makeTracks(2);
    await cacheShow(SHOW, tracks);
    const before = await resolveTracks(SHOW, tracks);

    releaseShowUrls(SHOW);

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    const again = await resolveTracks(SHOW, tracks);
    expect(again.tracks[0].url).not.toBe(before.tracks[0].url);
  });
});
