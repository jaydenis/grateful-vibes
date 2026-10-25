/**
 * Thin, framework-free wrapper around the audio elements.
 * One element is active at a time and is the only source of truth for playback
 * state; a second, hidden element buffers the next track in the last stretch of
 * the current one so a live show's tracks run together without a network gap, and
 * the two crossfade over the final two seconds so there is no audible hole either.
 */
const PRELOAD_WINDOW = 30; // seconds of lead time before the next track is fetched
const CROSSFADE_SECONDS = 2; // overlap between the tail of one track and the next
const FADE_TICK_MS = 40; // ~25 gain steps a second: smooth, without a frame timer

export function createPlayer() {
  const listeners = new Set();
  const elements = [];

  // The user's volume, kept apart from the elements' own levels so a fade can dim
  // them without the transport slider appearing to move.
  let volumeLevel = 0.85;

  function makeElement() {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.volume = volumeLevel;
    wire(audio);
    elements.push(audio);
    return audio;
  }

  let active = makeElement();
  let spare = null;
  let preload = null; // { url, index } for whatever the spare is buffering
  let preloadReady = false; // true once the spare has enough data to start at once
  let fade = null; // { out, in, startedAt, timer } while the two tracks overlap
  let queue = [];
  let index = -1;
  let context = null;
  let consecutiveFailures = 0;
  let pendingSeek = null;
  let loadShouldPlay = true;

  function snapshot() {
    return {
      queue,
      index,
      track: index >= 0 ? queue[index] : null,
      context,
      playing: !active.paused && !active.ended,
      currentTime: active.currentTime || 0,
      duration: Number.isFinite(active.duration) && active.duration > 0
        ? active.duration
        : queue[index]?.duration ?? 0,
      volume: volumeLevel,
      hasNext: index >= 0 && index + 1 < queue.length,
      hasPrev: index > 0,
      // Surfaced so the transport can show that the next track is ready to roll.
      preload: preload ? { index: preload.index, ready: preloadReady } : null,
      error: null,
    };
  }

  function notify(type, extra = {}) {
    const state = { ...snapshot(), ...extra };
    for (const listener of listeners) listener(type, state);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || index < 0) return;
    const track = queue[index];
    try {
      const label = context
        ? [context.venue, context.coverage, context.date].filter(Boolean).join(' · ')
        : 'Grateful Dead live';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: 'Grateful Dead',
        album: label,
      });
    } catch {
      /* MediaMetadata is unavailable in some browsers. */
    }
  }

  function startPlayback() {
    const promise = active.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch((error) => {
        if (error?.name === 'AbortError') return; // A newer track replaced this one.
        notify('error', {
          error: 'The browser blocked playback. Press play to start listening.',
        });
        notify('playpause');
      });
    }
  }

  /** Seconds left on the active track, or null while the duration is unknown. */
  function remainingSeconds() {
    const duration = Number.isFinite(active.duration) && active.duration > 0
      ? active.duration
      : queue[index]?.duration ?? 0;
    if (!duration) return null;
    return duration - (active.currentTime || 0);
  }

  function clampVolume(value) {
    return Math.min(Math.max(value, 0), 1);
  }

  /**
   * Equal-power gains across the overlap. A linear ramp dips about 6 dB halfway
   * through and reads as a hole in the music; cos/sin keeps the level even.
   */
  function applyFadeGains() {
    const progress = Math.min((performance.now() - fade.startedAt) / (CROSSFADE_SECONDS * 1000), 1);
    fade.out.volume = clampVolume(volumeLevel * Math.cos((progress * Math.PI) / 2));
    fade.in.volume = clampVolume(volumeLevel * Math.sin((progress * Math.PI) / 2));
    return progress;
  }

  /** Stop the overlap and hand both elements back to the user's volume. */
  function cancelCrossfade({ pauseIncoming = true } = {}) {
    if (!fade) return;
    const { in: incoming, out: outgoing } = fade;
    clearInterval(fade.timer);
    fade = null;
    if (pauseIncoming) {
      incoming.pause();
      // The buffered track keeps its data, but it must not resume mid-way next time.
      try {
        incoming.currentTime = 0;
      } catch {
        /* Before metadata loads there is nothing to rewind; playback starts at 0. */
      }
    }
    incoming.volume = volumeLevel;
    outgoing.volume = volumeLevel;
  }

  /**
   * Bring the next track in under the tail of the current one, two seconds before
   * it ends. Only the automatic handoff fades: skipping, seeking, and pausing all
   * cancel it so the transport stays instant.
   */
  function maybeCrossfade() {
    if (fade || index < 0) return false;
    const nextTrack = queue[index + 1];
    if (!spare || !preload || !preloadReady || !nextTrack || preload.url !== nextTrack.url) {
      return false;
    }
    const remaining = remainingSeconds();
    if (remaining == null || remaining > CROSSFADE_SECONDS) return false;

    fade = { out: active, in: spare, startedAt: performance.now(), timer: null };
    spare.volume = 0;
    const started = spare.play();
    if (started && typeof started.catch === 'function') {
      // A refused start just leaves the ordinary handoff to close the gap.
      started.catch(() => cancelCrossfade());
    }
    fade.timer = setInterval(() => {
      if (!fade) return;
      if (applyFadeGains() >= 1) {
        clearInterval(fade.timer);
        fade.timer = null;
        // The outgoing element is silent by now, so the boundary can move with no cut.
        promoteBufferedTrack();
      }
    }, FADE_TICK_MS);
    return true;
  }

  function dropPreload() {
    preload = null;
    preloadReady = false;
    if (spare && spare.hasAttribute('src')) {
      spare.pause();
      spare.removeAttribute('src');
      spare.load();
    }
  }

  /**
   * Fetch the upcoming track into the idle element while the current one is still
   * playing, so the handoff on 'ended' has data ready instead of opening a request.
   */
  function primeNextTrack() {
    if (index < 0) return;
    const nextIndex = index + 1;
    const track = queue[nextIndex];
    if (!track?.url || track.unavailable) return;
    if (preload?.url === track.url) return;

    const remaining = remainingSeconds();
    if (remaining == null || remaining > PRELOAD_WINDOW) return;

    if (!spare) {
      spare = makeElement();
      spare.volume = active.volume;
    }
    preload = { url: track.url, index: nextIndex };
    preloadReady = false;
    spare.src = track.url;
    spare.load();

    // canplay is the first point the buffered track can start without a stall.
    spare.addEventListener(
      'canplay',
      () => {
        if (!preload || preload.url !== track.url) return;
        preloadReady = true;
        notify('preload');
      },
      { once: true },
    );
  }

  /**
   * Promote the buffered element to active. Returns false when the spare is not
   * holding the track that actually comes next, so the caller can fall back.
   */
  function promoteBufferedTrack() {
    const nextTrack = queue[index + 1];
    if (!spare || !preload || !nextTrack || preload.url !== nextTrack.url) return false;

    // Close out any overlap first. The incoming element is already playing and
    // stays that way; the retiring one goes back to full volume so it can serve as
    // the next spare without being stuck at the 0 it faded to.
    cancelCrossfade({ pauseIncoming: false });

    const retiring = active;
    active = spare;
    spare = retiring;
    preload = null;
    preloadReady = false;
    index += 1;
    pendingSeek = null;
    loadShouldPlay = false;

    retiring.pause();
    retiring.volume = volumeLevel;
    retiring.removeAttribute('src');
    retiring.load();

    updateMediaSession();
    notify('track');
    startPlayback();
    return true;
  }

  function loadTrack(nextIndex, shouldPlay, resumeAt = null) {
    if (!queue.length) return;
    cancelCrossfade();
    dropPreload();
    index = Math.min(Math.max(nextIndex, 0), queue.length - 1);
    const track = queue[index];
    pendingSeek = Number.isFinite(resumeAt) ? Math.max(resumeAt, 0) : null;
    loadShouldPlay = shouldPlay;
    active.src = track.url;
    active.load();
    updateMediaSession();
    notify('track');
  }

  function next() {
    if (index + 1 < queue.length) loadTrack(index + 1, true);
  }

  function prev() {
    if (index < 0) return;
    if (active.currentTime > 3 || index === 0) {
      seek(0);
      return;
    }
    loadTrack(index - 1, true);
  }

  function seek(seconds) {
    if (index < 0 || !Number.isFinite(seconds)) return;
    cancelCrossfade();
    const duration = Number.isFinite(active.duration) ? active.duration : null;
    active.currentTime = duration
      ? Math.min(Math.max(seconds, 0), duration)
      : Math.max(seconds, 0);
    primeNextTrack();
    notify('time');
  }

  function setVolume(value) {
    if (!Number.isFinite(value)) return;
    volumeLevel = Math.min(Math.max(value, 0), 1);
    if (fade) {
      applyFadeGains();
      return;
    }
    active.volume = volumeLevel;
    if (spare) spare.volume = volumeLevel;
  }

  /** Drop the loaded show and silence playback without touching the queue order. */
  function stop() {
    cancelCrossfade();
    for (const audio of elements) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    queue = [];
    index = -1;
    context = null;
    pendingSeek = null;
    preload = null;
    preloadReady = false;
    consecutiveFailures = 0;
    loadShouldPlay = false;
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = null;
      } catch {
        /* Media Session is unavailable in some browsers. */
      }
    }
    notify('track');
    notify('playpause');
  }

  function wire(audio) {
    const isActive = () => audio === active;

    audio.addEventListener('play', () => {
      if (isActive()) notify('playpause');
    });
    audio.addEventListener('pause', () => {
      if (isActive()) notify('playpause');
    });
    audio.addEventListener('timeupdate', () => {
      if (!isActive()) return;
      primeNextTrack();
      maybeCrossfade();
      notify('time');
    });
    audio.addEventListener('durationchange', () => {
      if (!isActive()) return;
      primeNextTrack();
      maybeCrossfade();
      notify('time');
    });
    audio.addEventListener('loadedmetadata', () => {
      if (!isActive()) return;
      if (pendingSeek != null) {
        const limit = Number.isFinite(audio.duration) ? audio.duration : pendingSeek;
        audio.currentTime = Math.min(pendingSeek, limit);
        pendingSeek = null;
      }
      consecutiveFailures = 0;
      if (loadShouldPlay) {
        // Wait until the replacement source is ready before starting it. Calling
        // play() immediately after src/load can be aborted by desktop webviews.
        loadShouldPlay = false;
        startPlayback();
      }
      primeNextTrack();
      notify('time');
    });
    audio.addEventListener('volumechange', () => {
      // Gain ramps during a crossfade are not user volume changes.
      if (fade && fade.out === audio) return;
      if (isActive()) notify('volume');
    });
    audio.addEventListener('ended', () => {
      if (!isActive()) return;
      // The next track was buffered ahead of time; switch to it with no reload.
      if (promoteBufferedTrack()) return;
      if (index + 1 < queue.length) loadTrack(index + 1, true);
      else notify('playpause');
    });

    audio.addEventListener('error', () => {
      if (!isActive()) {
        // A preload that failed just means the next handoff will load normally.
        preload = null;
        preloadReady = false;
        notify('preload');
        return;
      }
      if (index < 0) return;
      pendingSeek = null;
      const failed = queue[index];
      failed.unavailable = true;
      notify('error', {
        error: `Couldn't stream "${failed.title}" — the file may be restricted or unavailable.`,
      });

      const nextIndex = queue.findIndex((track, i) => i > index && !track.unavailable);
      if (nextIndex !== -1 && consecutiveFailures < 5) {
        consecutiveFailures += 1;
        loadTrack(nextIndex, loadShouldPlay);
        return;
      }
      notify('track');
    });
  }

  if ('mediaSession' in navigator) {
    const actions = {
      play: () => startPlayback(),
      pause: () => active.pause(),
      nexttrack: next,
      previoustrack: prev,
    };
    for (const [action, handler] of Object.entries(actions)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* Unsupported action; ignore. */
      }
    }
  }

  return {
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Load a show and (optionally) start its first track. */
    playShow(showContext, tracks, startIndex = 0, shouldPlay = true) {
      if (!tracks?.length) return;
      queue = tracks;
      context = showContext;
      consecutiveFailures = 0;
      loadTrack(startIndex, shouldPlay);
    },
    /** Load a show paused at a saved position without starting playback. */
    restore(showContext, tracks, startIndex = 0, seconds = 0) {
      if (!tracks?.length) return;
      queue = tracks;
      context = showContext;
      consecutiveFailures = 0;
      loadTrack(startIndex, false, seconds);
    },
    toggle() {
      if (index < 0) return;
      // The transport outranks the overlap: cancel it, then act on the element the
      // listener is actually hearing.
      cancelCrossfade();
      if (active.paused) startPlayback();
      else active.pause();
    },
    next,
    prev,
    seek,
    setVolume,
    stop,
    snapshot,
  };
}
