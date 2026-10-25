/**
 * jsdom is missing a few browser surfaces this app relies on: ResizeObserver,
 * matchMedia, media element transport methods, and object URLs. Each stub is
 * inert on purpose — the tests assert app state, not real audio output.
 */
import { afterEach, vi } from 'vitest';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub;

if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
}

Element.prototype.scrollIntoView = vi.fn();

Object.defineProperties(window.HTMLMediaElement.prototype, {
  play: { configurable: true, writable: true, value: vi.fn(() => Promise.resolve()) },
  pause: { configurable: true, writable: true, value: vi.fn() },
  load: { configurable: true, writable: true, value: vi.fn() },
});

let objectUrlCount = 0;
URL.createObjectURL = vi.fn(() => `blob:test/${(objectUrlCount += 1)}`);
URL.revokeObjectURL = vi.fn();

afterEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
  vi.unstubAllGlobals();
  delete globalThis.caches;
});
