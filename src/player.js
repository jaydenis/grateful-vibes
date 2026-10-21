/**
 * Thin, framework-free wrapper around a single <audio> element.
 * The audio element is the only source of truth for playback state.
 */
export function createPlayer() {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = 0.85;

  const listeners = new Set();
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
      playing: !audio.paused && !audio.ended,
      currentTime: audio.currentTime || 0,
      duration: Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : queue[index]?.duration ?? 0,
      volume: audio.volume,
      hasNext: index >= 0 && index + 1 < queue.length,
      hasPrev: index > 0,
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
    const promise = audio.play();
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

  function loadTrack(nextIndex, shouldPlay, resumeAt = null) {
    if (!queue.length) return;
    index = Math.min(Math.max(nextIndex, 0), queue.length - 1);
    const track = queue[index];
    pendingSeek = Number.isFinite(resumeAt) ? Math.max(resumeAt, 0) : null;
    loadShouldPlay = shouldPlay;
    audio.src = track.url;
    audio.load();
    updateMediaSession();
    notify('track');
    if (shouldPlay) startPlayback();
  }

  function next() {
    if (index + 1 < queue.length) loadTrack(index + 1, true);
  }

  function prev() {
    if (index < 0) return;
    if (audio.currentTime > 3 || index === 0) {
      seek(0);
      return;
    }
    loadTrack(index - 1, true);
  }

  function seek(seconds) {
    if (index < 0 || !Number.isFinite(seconds)) return;
    const duration = Number.isFinite(audio.duration) ? audio.duration : null;
    audio.currentTime = duration ? Math.min(Math.max(seconds, 0), duration) : Math.max(seconds, 0);
    notify('time');
  }

  function setVolume(value) {
    if (!Number.isFinite(value)) return;
    audio.volume = Math.min(Math.max(value, 0), 1);
  }

  /** Drop the loaded show and silence playback without touching the queue order. */
  function stop() {
    audio.pause();
    queue = [];
    index = -1;
    context = null;
    pendingSeek = null;
    consecutiveFailures = 0;
    loadShouldPlay = false;
    audio.removeAttribute('src');
    audio.load();
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

  audio.addEventListener('play', () => notify('playpause'));
  audio.addEventListener('pause', () => notify('playpause'));
  audio.addEventListener('timeupdate', () => notify('time'));
  audio.addEventListener('durationchange', () => notify('time'));
  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek != null) {
      const limit = Number.isFinite(audio.duration) ? audio.duration : pendingSeek;
      audio.currentTime = Math.min(pendingSeek, limit);
      pendingSeek = null;
    }
    consecutiveFailures = 0;
    notify('time');
  });
  audio.addEventListener('volumechange', () => notify('volume'));
  audio.addEventListener('ended', () => {
    if (index + 1 < queue.length) loadTrack(index + 1, true);
    else notify('playpause');
  });

  audio.addEventListener('error', () => {
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

  if ('mediaSession' in navigator) {
    const actions = {
      play: () => startPlayback(),
      pause: () => audio.pause(),
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
      if (audio.paused) startPlayback();
      else audio.pause();
    },
    next,
    prev,
    seek,
    setVolume,
    stop,
    snapshot,
  };
}
