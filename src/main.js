import 'bootstrap/dist/css/bootstrap.min.css';
import './style.css';
import { exit, onBackButtonPress } from '@tauri-apps/api/app';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { fetchCatalog, fetchShowTracks, fetchSongbook, fetchSongShows } from './api.js';
import { createPlayer } from './player.js';
import {
  DEFAULT_THEME_ID,
  THEMES,
  chooseAccentText,
  getTheme,
  readableInk,
  themeActionColor,
  themeBackground,
  themeInks,
} from './themes.js';
import {
  addRecentShow,
  clearAllData,
  clearRecentShows,
  clearSession,
  loadRecentShows,
  loadSession,
  loadSettings,
  saveSession,
  saveSettings,
} from './storage.js';

const PAGE_SIZE = 40;
const MIN_SEARCH_LENGTH = 3;
const MONTH_ABBR = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
/** Uppercased month name for an ISO month number (1-12), formatted by Intl. */
const monthAbbr = (month) =>
  MONTH_ABBR.format(new Date(Date.UTC(2000, month - 1, 1))).toUpperCase();
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
/** Show rows open the setlist, so the row badge is a disclosure chevron, not a play glyph. */
const TRACKLIST_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const el = (id) => document.getElementById(id);
const els = {
  brandVersion: el('brand-version'),
  catalogCount: el('catalog-count'),
  listStatus: el('list-status'),
  listAlert: el('list-alert'),
  listAlertMsg: el('list-alert-msg'),
  listRetry: el('list-retry'),
  showList: el('show-list'),
  listSkeleton: el('list-skeleton'),
  loadMore: el('load-more'),
  listEnd: el('list-end'),
  search: el('search'),
  searchWrap: el('search-wrap'),
  searchClear: el('search-clear'),
  themeWrap: document.querySelector('.theme-wrap'),
  themeButton: el('theme-button'),
  themeMenu: el('theme-menu'),
  themeOptions: el('theme-options'),
  themeLabel: el('theme-label'),
  themeSwatches: el('theme-swatches'),
  resetData: el('reset-data'),
  resetMenu: el('reset-menu'),
  resetConfirm: el('reset-confirm'),
  resetCancel: el('reset-cancel'),
  resetStatus: el('reset-status'),
  catalogChoices: el('catalog-choices'),
  choiceButtons: [...document.querySelectorAll('[data-dimension]')],
  recent: el('recent'),
  recentList: el('recent-list'),
  recentClear: el('recent-clear'),
  drillBar: el('drill-bar'),
  drillBack: el('drill-back'),
  drillKicker: el('drill-kicker'),
  drillTitle: el('drill-title'),
  pickerList: el('picker-list'),
  loadMoreWrap: document.querySelector('.load-more-wrap'),
  panel: el('panel'),
  panelBackdrop: el('panel-backdrop'),
  panelEmpty: el('panel-empty'),
  panelContent: el('panel-content'),
  panelDate: el('panel-date'),
  panelTitle: el('panel-title'),
  panelVenue: el('panel-venue'),
  panelPlay: el('panel-play'),
  panelLink: el('panel-link'),
  panelNote: el('panel-note'),
  panelClose: el('panel-close'),
  trackSearchWrap: el('track-search-wrap'),
  trackSearch: el('track-search'),
  trackSearchClear: el('track-search-clear'),
  trackSearchStatus: el('track-search-status'),
  trackList: el('track-list'),
  trackSkeleton: el('track-skeleton'),
  npTrack: el('np-track'),
  npShow: el('np-show'),
  npPreload: el('np-preload'),
  npToggle: el('np-toggle'),
  npPrev: el('np-prev'),
  npNext: el('np-next'),
  npStop: el('np-stop'),
  npSeek: el('np-seek'),
  npCurrent: el('np-current'),
  npDuration: el('np-duration'),
  npVolume: el('np-volume'),
  npOutput: el('np-output'),
  npOutputMode: el('np-output-mode'),
  npSonosRooms: el('np-sonos-rooms'),
  npSonosRefresh: el('np-sonos-refresh'),
  npOutputStatus: el('np-output-status'),
};

const themeColorMeta = document.querySelector('meta[name="theme-color"]');

const state = {
  shows: [],
  total: 0,
  recordings: 0,
  visible: PAGE_SIZE,
  loading: false,
  query: '',
  searchRaw: '',
  trackQuery: '',
  trackSearchRaw: '',
  dimension: null,
  value: null,
  city: { country: null, region: null, city: null },
  song: {
    list: [],
    loading: false,
    loaded: false,
    error: null,
    selectedKey: null,
    selectedName: '',
    selectedSlugs: [],
    shows: [],
    totalShows: 0,
    showsLoading: false,
    showsError: null,
  },
  selectedId: null,
  show: null,
  tracks: [],
  tracksLoading: false,
};

const player = createPlayer();
const output = {
  mode: 'local',
  supported: false,
  rooms: [],
  roomId: '',
  roomIds: [],
  selectionLocked: false,
  sonos: { queue: [], index: -1, context: null, playing: false, sawPlaying: false, currentTime: 0, duration: 0, volume: 0.5 },
  polling: false,
};
const mobileQuery = window.matchMedia('(max-width: 991.98px)');
const nowPlayingEl = el('now-playing');

let panelRequest = null;
let restoreEpoch = 0;
let seeking = false;
let recentShows = loadRecentShows();
let sessionRestored = false;
let sessionSavedAt = 0;
let settingsSavedAt = 0;
let sonosVolumeTimer = 0;
let songShowsController = null;
let listRetryAction = loadCatalog;
let activeTheme = getTheme(DEFAULT_THEME_ID);
const songShowsCache = new Map();

/* ---------------------------------------------------------------- helpers */

function hash(value) {
  let total = 0;
  for (const char of String(value)) total = (total * 31 + char.charCodeAt(0)) >>> 0;
  return total;
}

function activeSnapshot() {
  if (output.mode !== 'sonos') return player.snapshot();
  const sonos = output.sonos;
  return {
    ...sonos,
    track: sonos.index >= 0 ? sonos.queue[sonos.index] : null,
    hasNext: sonos.index >= 0 && sonos.index + 1 < sonos.queue.length,
    hasPrev: sonos.index > 0,
    error: null,
  };
}

function setOutputStatus(message = '', isError = false) {
  els.npOutputStatus.textContent = message;
  els.npOutputStatus.classList.toggle('is-error', isError);
}

function renderRoomChoices() {
  const legend = document.createElement('legend');
  legend.className = 'visually-hidden';
  legend.textContent = 'Select one or two Sonos rooms';
  const help = document.createElement('span');
  help.className = 'visually-hidden';
  help.textContent = 'Select one room or both. Stop playback before changing rooms.';
  const fragment = document.createDocumentFragment();
  fragment.append(legend, help);
  for (const room of output.rooms) {
    const label = document.createElement('label');
    label.className = 'np-sonos-room-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = room.id;
    checkbox.checked = output.roomIds.includes(room.id);
    checkbox.disabled = output.selectionLocked || (output.roomIds.length >= 2 && !checkbox.checked);
    const name = document.createElement('span');
    name.textContent = room.name;
    label.append(checkbox, name);
    fragment.append(label);
  }
  els.npSonosRooms.replaceChildren(fragment);
  els.npSonosRooms.disabled = !output.rooms.length;
}

function selectedRoomNames() {
  return output.roomIds.map((id) => output.rooms.find((room) => room.id === id)?.name).filter(Boolean);
}

async function updateRoomSelection() {
  if (output.selectionLocked) {
    renderRoomChoices();
    setOutputStatus('Stop playback before changing rooms.');
    return;
  }
  const previous = output.roomIds;
  const selected = [...els.npSonosRooms.querySelectorAll('input:checked')].map((input) => input.value);
  if (selected.length > 2) {
    renderRoomChoices();
    setOutputStatus('Select one or two rooms.');
    return;
  }
  output.roomIds = selected;
  output.roomId = selected[0] ?? '';
  for (const removedId of previous.filter((id) => !selected.includes(id))) {
    if (previous.length > 1) {
      void invoke('sonos_player_leave', { playerId: removedId }).catch(() => {});
    }
  }
  renderRoomChoices();
  setOutputStatus(selectedRoomNames().join(' + ') || 'Choose one or two Sonos rooms.');
  if (output.mode === 'sonos') renderTransport(activeSnapshot());
}

async function refreshSonosRooms() {
  if (!output.supported) return;
  els.npSonosRefresh.disabled = true;
  setOutputStatus('Searching for Sonos rooms…');
  try {
    output.rooms = await invoke('sonos_discover');
    output.roomIds = output.roomIds.filter((id) => output.rooms.some((room) => room.id === id));
    output.roomId = output.roomIds[0] ?? '';
    renderRoomChoices();
    setOutputStatus(output.rooms.length ? `${output.rooms.length} room${output.rooms.length === 1 ? '' : 's'} found` : 'No rooms found. Check the same network and UPnP setting.', !output.rooms.length);
  } catch (error) {
    output.rooms = [];
    output.roomIds = [];
    output.roomId = '';
    renderRoomChoices();
    setOutputStatus(error?.toString?.() || 'Sonos discovery failed. Check your network and UPnP setting.', true);
  } finally {
    els.npSonosRefresh.disabled = false;
  }
}

async function sonosControl(action, value) {
  if (!output.roomId) {
    setOutputStatus('Choose a Sonos room first.', true);
    return false;
  }
  if (action === 'volume' && output.roomIds.length > 1) {
    const results = await Promise.allSettled(output.roomIds.map((playerId) => invoke('sonos_control', {
      playerId,
      action,
      value: value == null ? null : String(value),
    })));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) setOutputStatus(failed.reason?.toString?.() || 'Could not set both room volumes.', true);
    else setOutputStatus(selectedRoomNames().join(' + '));
    return !failed;
  }
  try {
    await invoke('sonos_control', {
      playerId: output.roomId,
      action,
      value: value == null ? null : String(value),
    });
    setOutputStatus(output.rooms.find((room) => room.id === output.roomId)?.name ?? 'Sonos connected');
    return true;
  } catch (error) {
    setOutputStatus(error?.toString?.() || 'Sonos could not complete that command.', true);
    return false;
  }
}

async function playOnSonos(show, tracks, index, resumeAt = 0) {
  if (!output.roomId) {
    setOutputStatus('Choose a Sonos room first.', true);
    return;
  }
  const track = tracks[index];
  if (!track || track.unavailable) return;
  const browserState = player.snapshot();
  if (browserState.playing) player.toggle();
  output.sonos = { queue: tracks, index, context: show, playing: true, sawPlaying: false, currentTime: resumeAt, duration: track.duration || 0, volume: output.sonos.volume };
  output.selectionLocked = true;
  renderRoomChoices();
  els.npOutputMode.value = 'sonos';
  renderTransport(activeSnapshot());
  highlightTracks(activeSnapshot());
  setOutputStatus(`Connecting to ${selectedRoomNames().join(' + ')}…`);
  try {
    if (output.roomIds.length > 1) {
      const coordinator = output.rooms.find((room) => room.id === output.roomIds[0]);
      await invoke('sonos_player_join', {
        playerId: output.roomIds[1],
        coordinatorRinconId: coordinator.rinconId,
      });
    }
    await invoke('sonos_play', { playerId: output.roomId, url: track.url, title: track.title });
    if (resumeAt > 0) await sonosControl('seek', resumeAt);
    setOutputStatus(selectedRoomNames().join(' + ') || 'Sonos connected');
    rememberShow(show);
  } catch (error) {
    output.sonos.playing = false;
    output.selectionLocked = false;
    renderRoomChoices();
    renderTransport(activeSnapshot());
    setOutputStatus(error?.toString?.() || 'Sonos could not play this track. Check Archive.org availability and speaker access.', true);
  }
}

async function pollSonos() {
  if (output.mode !== 'sonos' || !output.roomId || output.polling) return;
  output.polling = true;
  try {
    const status = await invoke('sonos_status', { playerId: output.roomId });
    const wasPlaying = output.sonos.playing;
    const trackHadStarted = output.sonos.sawPlaying;
    const previousTime = output.sonos.currentTime;
    output.sonos.currentTime = status.position;
    output.sonos.duration = status.duration || output.sonos.queue[output.sonos.index]?.duration || 0;
    output.sonos.playing = status.state === 'PLAYING';
    if (output.sonos.playing) output.sonos.sawPlaying = true;
    if (status.transportStatus && status.transportStatus !== 'OK') {
      setOutputStatus('Sonos could not play this stream. Check the Archive.org file format and the speaker’s internet access.', true);
    }
    const reachedTrackEnd = [previousTime, status.position].some((position) =>
      output.sonos.duration > 0 && position >= output.sonos.duration - 1,
    );
    let advanced = false;
    if (wasPlaying && trackHadStarted && status.state === 'STOPPED' && reachedTrackEnd && output.sonos.index + 1 < output.sonos.queue.length) {
      output.sonos.index += 1;
      output.sonos.currentTime = 0;
      await invoke('sonos_play', { playerId: output.roomId, url: output.sonos.queue[output.sonos.index].url, title: output.sonos.queue[output.sonos.index].title });
      output.sonos.playing = true;
      output.sonos.sawPlaying = false;
      advanced = true;
    }
    if (!advanced && status.state === 'STOPPED' && output.sonos.index + 1 >= output.sonos.queue.length) {
      output.selectionLocked = false;
      renderRoomChoices();
    }
    saveCurrentSession(activeSnapshot());
    renderTransport(activeSnapshot());
    highlightTracks(activeSnapshot());
  } catch (error) {
    setOutputStatus(error?.toString?.() || 'Lost connection to the Sonos room.', true);
  } finally {
    output.polling = false;
  }
}

function toggleOutput() {
  const snapshot = activeSnapshot();
  if (!snapshot.track) return;
  if (output.mode === 'sonos') {
    if (!output.selectionLocked && !output.sonos.playing) {
      playOnSonos(output.sonos.context, output.sonos.queue, output.sonos.index, output.sonos.currentTime);
      return;
    }
    output.sonos.playing = !output.sonos.playing;
    renderTransport(activeSnapshot());
    sonosControl(output.sonos.playing ? 'play' : 'pause');
  } else player.toggle();
}

async function stopSonos() {
  if (!output.roomId) return;
  if (!await sonosControl('stop')) return;
  output.sonos.playing = false;
  output.selectionLocked = false;
  renderRoomChoices();
  renderTransport(activeSnapshot());
}

function nextOutput() {
  const snapshot = activeSnapshot();
  if (!snapshot.hasNext) return;
  if (output.mode === 'sonos') {
    output.sonos.index += 1;
    playOnSonos(output.sonos.context, output.sonos.queue, output.sonos.index);
  } else player.next();
}

function previousOutput() {
  const snapshot = activeSnapshot();
  if (!snapshot.hasPrev && snapshot.currentTime <= 3) return;
  if (output.mode === 'sonos') {
    if (snapshot.currentTime > 3 || snapshot.index === 0) {
      output.sonos.currentTime = 0;
      sonosControl('seek', 0);
    } else {
      output.sonos.index -= 1;
      playOnSonos(output.sonos.context, output.sonos.queue, output.sonos.index);
    }
  } else player.prev();
}

function chooseOutput(mode) {
  if (mode === output.mode) return;
  if (mode === 'sonos') {
    output.mode = 'sonos';
    els.npSonosRooms.hidden = false;
    els.npVolume.value = String(output.sonos.volume);
    setRangeFill(els.npVolume);
    const local = player.snapshot();
    if (local.playing) player.toggle();
    setOutputStatus(selectedRoomNames().join(' + ') || 'Choose one or two Sonos rooms.');
    if (output.roomId && local.track) playOnSonos(local.context, local.queue, local.index, local.currentTime);
    renderTransport(activeSnapshot());
    return;
  }
  const sonos = output.sonos;
  if (sonos.playing) sonosControl('stop');
  for (const followerId of output.roomIds.slice(1)) {
    void invoke('sonos_player_leave', { playerId: followerId }).catch(() => {});
  }
  output.selectionLocked = false;
  renderRoomChoices();
  const local = player.snapshot();
  if (local.track && sonos.queue[sonos.index]?.id === local.track.id && sonos.context?.id === local.context?.id) player.seek(sonos.currentTime);
  output.mode = 'local';
  els.npSonosRooms.hidden = true;
  els.npVolume.value = String(local.volume);
  setRangeFill(els.npVolume);
  setOutputStatus(output.rooms.find((room) => room.id === output.roomId)?.name ?? '');
  renderTransport(player.snapshot());
}

async function initializeSonos() {
  if (!isTauri()) return;
  try {
    output.supported = await invoke('sonos_supported');
    if (!output.supported) return;
    els.npOutput.hidden = false;
    await refreshSonosRooms();
    window.setInterval(pollSonos, 1000);
  } catch {
    // Sonos output is optional; regular browser playback remains available.
  }
}

function isoParts(iso) {
  const match = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function formatLongDate(iso) {
  const parts = isoParts(iso);
  if (!parts) return 'Date unknown';
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatShortDate(iso) {
  const parts = isoParts(iso);
  if (!parts) return '';
  return `${monthAbbr(parts.month)} ${parts.day}, ${parts.year}`;
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function formatCompact(value) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 }).format(
    Number(value) || 0,
  );
}

/** Text searches only run once the query is at least three characters long. */
function normalizeSearch(raw) {
  const value = String(raw ?? '').trim();
  return value.length >= MIN_SEARCH_LENGTH ? value.toLowerCase() : '';
}

function setRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const percent = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${Math.min(Math.max(percent, 0), 100)}%`);
}

/* ------------------------------------------------------------- show list */

const DIMENSIONS = {
  venue: {
    singular: 'Venue',
    plural: 'Venues',
    placeholder: 'Filter venues…',
    where: 'at',
    pick: (show) => show.venue,
    unknown: 'Unknown venue',
  },
  year: {
    singular: 'Year',
    plural: 'Years',
    placeholder: 'Filter years…',
    where: 'from',
    pick: (show) => isoParts(show.date)?.year ?? '',
    unknown: 'Unknown year',
  },
  history: {
    singular: 'This Day in History',
    plural: 'This Day in History',
    placeholder: 'Filter these shows…',
    where: 'on',
  },
};

const UNKNOWN_KEY = '__unknown__';

const groups = { venue: [], year: [], history: [] };

function buildHistoryGroup(shows, date = new Date()) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const key = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const label = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' }).format(date);
  const matchingShows = shows
    .filter((show) => {
      const parts = isoParts(show.date);
      return parts?.month === month && parts?.day === day;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return [{ key, label, shows: matchingShows, labels: new Map() }];
}

let cityCountries = [];
let cityCountryMap = new Map();

/**
 * Group labels case-insensitively, collapse whitespace and the obvious venue
 * spelling variants the Archive mixes ("Amphitheatre" / "Amphitheater"), and
 * drop trailing punctuation. Empty values share one "Unknown" group.
 */
function normalizeGroupKey(raw) {
  const value = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/^[.,;:]+/, '')
    .replace(/[.,;:]+$/, '');
  if (!/[a-z0-9]/.test(value) || value.startsWith('?')) return UNKNOWN_KEY;
  return value
    .replace(/\bamphitheat(?:er|re)\b/g, 'amphitheater')
    .replace(/\btheat(?:er|re)\b/g, 'theater');
}

function cleanLabel(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^[.,;:]+/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
}

/* ------------------------------------------------------- city hierarchy */

const US_STATE_NAMES = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

const CA_PROVINCE_NAMES = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
};

const COUNTRY_ALIASES = new Map([
  ['us', 'united states'],
  ['usa', 'united states'],
  ['u.s.', 'united states'],
  ['u.s.a.', 'united states'],
  ['united states', 'united states'],
  ['united states of america', 'united states'],
  ['uk', 'united kingdom'],
  ['u.k.', 'united kingdom'],
  ['united kingdom', 'united kingdom'],
  ['great britain', 'united kingdom'],
  ['england', 'united kingdom'],
  ['scotland', 'united kingdom'],
  ['wales', 'united kingdom'],
  ['northern ireland', 'united kingdom'],
  ['west germany', 'germany'],
  ['holland', 'netherlands'],
  ['czechia', 'czech republic'],
  ['d\u00e4nemark (denmark)', 'denmark'],
]);

const COUNTRY_LABELS = new Map([
  ['united states', 'United States'],
  ['united kingdom', 'United Kingdom'],
  ['germany', 'Germany'],
  ['netherlands', 'Netherlands'],
  ['denmark', 'Denmark'],
  ['czech republic', 'Czech Republic'],
]);

/** Two-letter country codes the Archive occasionally uses ("London, EN"). */
const COUNTRY_CODES = new Map([
  ['en', { key: 'united kingdom', label: 'United Kingdom' }],
  ['fr', { key: 'france', label: 'France' }],
  ['ge', { key: 'germany', label: 'Germany' }],
  ['sp', { key: 'spain', label: 'Spain' }],
  ['sw', { key: 'sweden', label: 'Sweden' }],
  ['it', { key: 'italy', label: 'Italy' }],
  ['au', { key: 'australia', label: 'Australia' }],
  ['jp', { key: 'japan', label: 'Japan' }],
  ['nz', { key: 'new zealand', label: 'New Zealand' }],
  ['mx', { key: 'mexico', label: 'Mexico' }],
  ['br', { key: 'brazil', label: 'Brazil' }],
  ['ie', { key: 'ireland', label: 'Ireland' }],
  ['dk', { key: 'denmark', label: 'Denmark' }],
  ['no', { key: 'norway', label: 'Norway' }],
  ['fi', { key: 'finland', label: 'Finland' }],
  ['pl', { key: 'poland', label: 'Poland' }],
  ['cz', { key: 'czech republic', label: 'Czech Republic' }],
  ['at', { key: 'austria', label: 'Austria' }],
  ['ch', { key: 'switzerland', label: 'Switzerland' }],
  ['be', { key: 'belgium', label: 'Belgium' }],
  ['pt', { key: 'portugal', label: 'Portugal' }],
  ['gr', { key: 'greece', label: 'Greece' }],
  ['tr', { key: 'turkey', label: 'Turkey' }],
  ['ru', { key: 'russia', label: 'Russia' }],
  ['za', { key: 'south africa', label: 'South Africa' }],
]);

const REGION_LOOKUP = new Map();

for (const [code, name] of Object.entries(US_STATE_NAMES)) {
  const info = { countryKey: 'united states', regionKey: normalizeGroupKey(name) };
  REGION_LOOKUP.set(code.toLowerCase(), info);
  REGION_LOOKUP.set(name.toLowerCase(), info);
}

for (const [code, name] of Object.entries(CA_PROVINCE_NAMES)) {
  const info = { countryKey: 'canada', regionKey: normalizeGroupKey(name) };
  REGION_LOOKUP.set(code.toLowerCase(), info);
  REGION_LOOKUP.set(name.toLowerCase(), info);
}

const UNKNOWN_PLACE = {
  countryKey: UNKNOWN_KEY,
  countryLabel: 'Unknown country',
  regionKey: null,
  regionLabel: null,
  cityKey: UNKNOWN_KEY,
  cityLabel: '',
};

const UNKNOWN_PLACE_WORDS = /^(unknown|various.*|multiple|compilation|studio|unknown location|none|n\/a)$/i;

function countryLabelFor(key) {
  return COUNTRY_LABELS.get(key) ?? '';
}

function resolveCountry(raw) {
  const label = cleanLabel(raw);
  const key = normalizeGroupKey(label);
  if (!key || key === UNKNOWN_KEY || UNKNOWN_PLACE_WORDS.test(label)) {
    return { key: UNKNOWN_KEY, label: 'Unknown country' };
  }

  const compact = label.toLowerCase().replace(/\./g, '');
  if (/^[a-z]{2}$/.test(compact)) {
    const coded = COUNTRY_CODES.get(compact);
    if (coded) return { key: coded.key, label: coded.label };
  }

  const alias = COUNTRY_ALIASES.get(key) ?? key;
  return { key: alias, label: COUNTRY_LABELS.get(alias) ?? label };
}

/** Match a state/province code or full name, including mixed case and "D.C.". */
function cityKeyFor(label) {
  if (!label || UNKNOWN_PLACE_WORDS.test(label)) return UNKNOWN_KEY;
  return normalizeGroupKey(label);
}

function resolveRegion(raw) {
  const label = cleanLabel(raw);
  if (!label) return null;
  const compact = label
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return REGION_LOOKUP.get(compact) ?? null;
}

/**
 * Coverage is free text: "Albany, NY", "Aarhus, Denmark",
 * "Winnipeg, Manitoba, Canada", "Flushing Meadows, Queens, New York, NY".
 * Split it into a country, an optional state/province, and a city; anything
 * that cannot be placed lands in the Unknown bucket at each level.
 */
function parseCoverage(raw) {
  const value = cleanLabel(raw).replace(/;/g, ',');
  if (!value || UNKNOWN_PLACE_WORDS.test(value)) return { ...UNKNOWN_PLACE };

  const parts = value
    .split(',')
    .map((part) => cleanLabel(part))
    .filter(Boolean);

  if (parts.length === 1) {
    const only = parts[0];
    if (/^washington,?\s*d\.?c\.?$/i.test(only)) {
      return {
        countryKey: 'united states',
        countryLabel: 'United States',
        regionKey: normalizeGroupKey('District of Columbia'),
        regionLabel: 'DC',
        cityKey: cityKeyFor('Washington'),
        cityLabel: 'Washington',
      };
    }
    const region = resolveRegion(only);
    if (region) {
      return {
        ...UNKNOWN_PLACE,
        countryKey: region.countryKey,
        countryLabel: countryLabelFor(region.countryKey),
        regionKey: region.regionKey,
        regionLabel: only,
      };
    }
    return { ...UNKNOWN_PLACE, cityKey: cityKeyFor(only), cityLabel: only };
  }

  if (parts.length === 2) {
    const [city, second] = parts;
    const region = resolveRegion(second);
    if (region) {
      return {
        countryKey: region.countryKey,
        countryLabel: countryLabelFor(region.countryKey),
        regionKey: region.regionKey,
        regionLabel: second,
        cityKey: cityKeyFor(city),
        cityLabel: city,
      };
    }

    const country = resolveCountry(second);
    if (country.key === UNKNOWN_KEY || /[()]$/.test(second)) {
      return { ...UNKNOWN_PLACE, cityKey: cityKeyFor(city), cityLabel: city };
    }

    return {
      countryKey: country.key,
      countryLabel: country.label,
      regionKey: null,
      regionLabel: null,
      cityKey: cityKeyFor(city),
      cityLabel: city,
    };
  }

  if (/\band\b/i.test(value)) return { ...UNKNOWN_PLACE };

  const city = parts[0];
  const last = parts[parts.length - 1];
  const lastRegion = resolveRegion(last);
  if (lastRegion) {
    return {
      countryKey: lastRegion.countryKey,
      countryLabel: countryLabelFor(lastRegion.countryKey),
      regionKey: lastRegion.regionKey,
      regionLabel: last,
      cityKey: cityKeyFor(city),
      cityLabel: city,
    };
  }

  const country = resolveCountry(last);
  if (country.key === UNKNOWN_KEY || /[\d()]/.test(last)) return { ...UNKNOWN_PLACE };

  const middle = parts.slice(1, -1).join(', ');
  const middleRegion = resolveRegion(middle);
  return {
    countryKey: country.key,
    countryLabel: country.label,
    regionKey: middle ? (middleRegion?.regionKey ?? normalizeGroupKey(middle)) : null,
    regionLabel: middle || null,
    cityKey: cityKeyFor(city),
    cityLabel: city,
  };
}

function addLabel(labels, label) {
  if (label) labels.set(label, (labels.get(label) || 0) + 1);
}

function mostCommonLabel(labels, fallback) {
  if (!labels.size) return fallback;
  return [...labels.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }),
  )[0][0];
}

function addCity(cities, place, show) {
  let city = cities.get(place.cityKey);
  if (!city) {
    city = {
      key: place.cityKey,
      label: place.cityKey === UNKNOWN_KEY ? 'Unknown city' : place.cityLabel,
      labels: new Map(),
      shows: [],
    };
    cities.set(place.cityKey, city);
  }
  city.shows.push(show);
  if (place.cityKey !== UNKNOWN_KEY) addLabel(city.labels, place.cityLabel);
}

function buildCityTree(shows) {
  const countries = new Map();

  for (const show of shows) {
    const place = parseCoverage(show.coverage);
    let country = countries.get(place.countryKey);
    if (!country) {
      country = {
        key: place.countryKey,
        label: place.countryLabel,
        labels: new Map(),
        shows: [],
        entries: [],
        regions: new Map(),
        cities: new Map(),
        hasRegions: false,
      };
      countries.set(place.countryKey, country);
    }
    country.shows.push(show);
    if (place.countryKey !== UNKNOWN_KEY) addLabel(country.labels, place.countryLabel);
    country.entries.push({ show, place });
  }

  for (const country of countries.values()) {
    country.hasRegions = country.entries.some(({ place }) => place.regionKey != null);
    country.label =
      country.key === UNKNOWN_KEY
        ? 'Unknown country'
        : mostCommonLabel(country.labels, country.label) || country.label;

    for (const { show, place } of country.entries) {
      if (!country.hasRegions) {
        addCity(country.cities, place, show);
        continue;
      }

      const regionKey = place.regionKey ?? UNKNOWN_KEY;
      let region = country.regions.get(regionKey);
      if (!region) {
        region = {
          key: regionKey,
          label: regionKey === UNKNOWN_KEY ? 'Unknown state/province' : place.regionLabel,
          labels: new Map(),
          shows: [],
          cities: new Map(),
        };
        country.regions.set(regionKey, region);
      }
      region.shows.push(show);
      if (place.regionKey) addLabel(region.labels, place.regionLabel);
      addCity(region.cities, place, show);
    }

    delete country.entries;

    for (const region of country.regions.values()) {
      if (region.key !== UNKNOWN_KEY) region.label = mostCommonLabel(region.labels, region.label);
      for (const city of region.cities.values()) {
        if (city.key !== UNKNOWN_KEY) city.label = mostCommonLabel(city.labels, city.label);
      }
    }
    for (const city of country.cities.values()) {
      if (city.key !== UNKNOWN_KEY) city.label = mostCommonLabel(city.labels, city.label);
    }
  }

  cityCountryMap = countries;
  cityCountries = [...countries.values()];
}

function findCountry(key) {
  return cityCountryMap.get(key) ?? null;
}

function selectedRegion() {
  const country = findCountry(state.city.country);
  if (!country || !state.city.region) return null;
  return country.regions.get(state.city.region) ?? null;
}

function selectedCityNode() {
  const country = findCountry(state.city.country);
  if (!country || !state.city.city) return null;
  const region = state.city.region ? country.regions.get(state.city.region) : null;
  const cities = region ? region.cities : country.cities;
  return cities.get(state.city.city) ?? null;
}

function cityLevel() {
  if (!state.city.country) return 'country';
  const country = findCountry(state.city.country);
  if (!country) return 'country';
  if (country.hasRegions && !state.city.region) return 'region';
  if (!state.city.city) return 'city';
  return 'shows';
}

function sortedNodes(nodes) {
  return [...nodes].sort((a, b) => {
    if (a.key === UNKNOWN_KEY) return 1;
    if (b.key === UNKNOWN_KEY) return -1;
    return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' });
  });
}

function filterGroupList(list) {
  const query = state.query;
  if (!query) return list;
  return list.filter((group) => group.label.toLowerCase().includes(query));
}

function appendSearchHint() {
  const raw = state.searchRaw.trim();
  if (!raw || raw.length >= MIN_SEARCH_LENGTH) return;
  const remaining = MIN_SEARCH_LENGTH - raw.length;
  els.listStatus.textContent += ` · type ${remaining} more character${
    remaining === 1 ? '' : 's'
  } to search`;
}

/* ------------------------------------------------------------ grouping */

function buildGroups(shows, dimension) {
  const config = DIMENSIONS[dimension];
  const byKey = new Map();

  for (const show of shows) {
    const raw = cleanLabel(config.pick(show));
    const key = normalizeGroupKey(raw);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: key === UNKNOWN_KEY ? config.unknown : raw, shows: [], labels: new Map() };
      byKey.set(key, group);
    }
    group.shows.push(show);
    if (key !== UNKNOWN_KEY) group.labels.set(raw, (group.labels.get(raw) || 0) + 1);
  }

  for (const group of byKey.values()) {
    if (!group.labels.size) continue;
    group.label = [...group.labels.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }),
    )[0][0];
  }

  return [...byKey.values()];
}

function sortedGroups(dimension) {
  const list = [...groups[dimension]];
  if (dimension === 'year') {
    return list.sort((a, b) => {
      const first = Number(a.key);
      const second = Number(b.key);
      const firstKnown = Number.isFinite(first);
      const secondKnown = Number.isFinite(second);
      if (firstKnown && secondKnown) return second - first;
      if (firstKnown) return -1;
      if (secondKnown) return 1;
      return 0;
    });
  }
  return list.sort((a, b) => {
    if (a.key === UNKNOWN_KEY) return 1;
    if (b.key === UNKNOWN_KEY) return -1;
    return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' });
  });
}

function selectedGroup() {
  if (!state.dimension || state.value == null) return null;
  return groups[state.dimension].find((group) => group.key === state.value) ?? null;
}

function matchesQuery(show, query) {
  return [show.title, show.venue, show.coverage, show.date, show.source]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function filteredGroupShows(group) {
  const query = state.query;
  if (!query) return group.shows;
  return group.shows.filter((show) => matchesQuery(show, query));
}

function filteredGroups(dimension) {
  return filterGroupList(sortedGroups(dimension));
}

function currentView() {
  if (!state.dimension) return 'root';
  if (state.dimension === 'city') return cityLevel() === 'shows' ? 'shows' : 'picker';
  if (state.dimension === 'song') return state.song.selectedKey ? 'shows' : 'picker';
  return state.value == null ? 'picker' : 'shows';
}

function updateCatalogCount() {
  els.catalogCount.textContent = state.total
    ? `${formatCount(state.total)} concerts in the vault`
    : '';
  els.catalogCount.title =
    state.total && state.recordings
      ? `Chosen from ${formatCount(state.recordings)} stream-only recordings, one per night`
      : '';
}

function renderRecent(visible) {
  const shows = visible
    ? recentShows
        .map((entry) => state.shows.find((show) => show.id === entry.id))
        .filter(Boolean)
    : [];

  els.recent.hidden = !shows.length;
  if (!shows.length) {
    els.recentList.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const show of shows) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.dataset.id = show.id;

    const date = document.createElement('span');
    date.className = 'recent-date';
    date.textContent = formatShortDate(show.date) || 'Date unknown';

    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = show.title;

    button.append(date, name);
    button.setAttribute(
      'aria-label',
      `Play ${show.title}${show.date ? `, ${formatLongDate(show.date)}` : ''}`,
    );
    item.append(button);
    fragment.append(item);
  }

  els.recentList.replaceChildren(fragment);
}

function rememberShow(show) {
  if (!show?.id || recentShows[0]?.id === show.id) return;
  recentShows = addRecentShow(show);
  if (currentView() === 'root') renderRecent(true);
}

let pendingSongKey = null;
let urlRestored = false;

/**
 * Keep the browse state in the URL so a view can be linked, reloaded, or shared.
 * replaceState (not pushState) keeps the back button out of filter changes.
 */
function syncUrl() {
  // Never overwrite an incoming link before restoreFromUrl has read it.
  if (!urlRestored) return;

  const params = new URLSearchParams();
  if (state.dimension) params.set('browse', state.dimension);

  if (state.dimension === 'city') {
    if (state.city.country) params.set('country', state.city.country);
    if (state.city.region) params.set('region', state.city.region);
    if (state.city.city) params.set('city', state.city.city);
  } else if (state.dimension === 'song') {
    if (state.song.selectedKey) params.set('song', state.song.selectedKey);
  } else if (state.value) {
    params.set('group', state.value);
  }

  const query = state.searchRaw.trim();
  if (query) params.set('q', query);

  const search = params.toString();
  const next = search ? `${location.pathname}?${search}` : location.pathname;
  if (next !== `${location.pathname}${location.search}`) {
    history.replaceState(null, '', next);
  }
}

/** Apply a linked view once the catalog is in memory. */
function restoreFromUrl() {
  if (urlRestored) return;
  urlRestored = true;

  const params = new URLSearchParams(location.search);
  const browse = params.get('browse');
  if (!browse) return;
  if (browse !== 'city' && browse !== 'song' && !DIMENSIONS[browse]) return;

  const applyQuery = () => {
    const query = (params.get('q') ?? '').trim();
    if (!query) return;
    els.search.value = query;
    state.searchRaw = query;
    state.query = normalizeSearch(query);
    els.searchClear.hidden = false;
  };

  if (browse === 'city') {
    setDimension('city', { reveal: false });
    state.city = {
      country: params.get('country'),
      region: params.get('region'),
      city: params.get('city'),
    };
    applyQuery();
    render();
    return;
  }

  if (browse === 'song') {
    pendingSongKey = params.get('song');
    setDimension('song', { reveal: false });
    applyQuery();
    if (state.song.loaded && pendingSongKey) {
      const key = pendingSongKey;
      pendingSongKey = null;
      selectSong(key);
    }
    render();
    return;
  }

  setDimension(browse, { reveal: false });
  const group = params.get('group');
  if (group) state.value = group;
  applyQuery();
  render();
}

function renderView() {
  const view = currentView();
  const isCity = state.dimension === 'city';
  const isSong = state.dimension === 'song';
  const config = state.dimension && !isCity && !isSong ? DIMENSIONS[state.dimension] : null;
  const group = !isCity && !isSong && view === 'shows' ? selectedGroup() : null;

  if (!isCity && !isSong && view === 'shows' && !group) {
    state.value = null;
    render();
    return;
  }

  els.catalogChoices.classList.toggle('is-compact', view !== 'root');
  for (const button of els.choiceButtons) {
    const active = button.dataset.dimension === state.dimension;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = state.loading || !state.shows.length;
  }

  els.drillBar.hidden = view === 'root';
  els.searchWrap.hidden = view === 'root';
  els.pickerList.hidden = view !== 'picker';
  els.showList.hidden = view !== 'shows';
  els.loadMoreWrap.hidden = view !== 'shows';
  els.searchClear.hidden = !state.searchRaw;

  updateCatalogCount();
  renderRecent(view === 'root');

  if (view === 'root') {
    els.showList.replaceChildren();
    els.pickerList.replaceChildren();
    updateRootChrome();
    return;
  }

  if (isCity) {
    renderCity(view);
    appendSearchHint();
    return;
  }

  if (isSong) {
    renderSong(view);
    appendSearchHint();
    return;
  }

  if (view === 'picker') {
    els.drillBack.textContent = '\u2190 All filters';
    els.drillBack.setAttribute('aria-label', 'Back to all filters');
    els.drillKicker.textContent = 'Browse by';
    els.drillTitle.textContent = config.plural;
    els.search.placeholder = config.placeholder;
    renderPicker(config);
    appendSearchHint();
    return;
  }

  const backLabel = state.dimension === 'history' ? 'All filters' : config.plural;
  els.drillBack.textContent = `\u2190 ${backLabel}`;
  els.drillBack.setAttribute('aria-label', `Back to ${backLabel.toLowerCase()}`);
  els.drillKicker.textContent = config.singular;
  els.drillTitle.textContent = group.label;
  els.search.placeholder = 'Filter these shows…';
  renderShows(group, config);
  appendSearchHint();
}

/** Every render reflects the current view into the URL. */
function render() {
  renderView();
  syncUrl();
}

function updateRootChrome() {
  if (state.loading && !state.shows.length) {
    els.listStatus.textContent = 'Loading the vault…';
  } else if (!state.total) {
    els.listStatus.textContent = 'The archive returned no shows.';
  } else {
    els.listStatus.textContent = `${formatCount(
      state.total,
    )} concerts · choose a venue, year, city, song, or This Day in History`;
  }
}

function createPickerItem(group, withCount) {
  const item = document.createElement('li');
  item.className = 'picker-item-wrap';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'picker-item';
  button.dataset.key = group.key;
  const accent = activeTheme.colors[hash(group.key) % activeTheme.colors.length];
  button.style.setProperty('--accent', accent);
  // The raw palette color is far too dark to draw a 12px arrow or chevron on the
  // row it also tints, so the ink variant carries every glyph on that row.
  button.style.setProperty('--accent-ink', readableInk(accent));

  const label = document.createElement('span');
  label.className = 'picker-label';
  label.textContent = group.label;
  button.append(label);

  const countValue = group.count ?? group.shows?.length ?? 0;
  const countLabel = group.countLabel ?? 'shows';
  if (withCount) {
    const count = document.createElement('span');
    count.className = 'picker-count';
    count.textContent = `(${formatCount(countValue)})`;
    button.append(count);
  }

  const arrow = document.createElement('span');
  arrow.className = 'picker-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '\u2192';
  button.append(arrow);

  button.setAttribute(
    'aria-label',
    withCount ? `${group.label}, ${formatCount(countValue)} ${countLabel}` : group.label,
  );

  item.append(button);
  return item;
}

function renderPicker(config) {
  const all = sortedGroups(state.dimension);
  const matches = filteredGroups(state.dimension);
  const fragment = document.createDocumentFragment();

  if (!matches.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = state.query
      ? `No ${config.plural.toLowerCase()} match “${state.searchRaw.trim()}”.`
      : `No ${config.plural.toLowerCase()} in the vault yet.`;
    fragment.append(empty);
  }

  for (const group of matches) {
    fragment.append(createPickerItem(group, false));
  }

  els.pickerList.replaceChildren(fragment);

  if (state.query) {
    els.listStatus.textContent = `${formatCount(matches.length)} of ${formatCount(
      all.length,
    )} ${config.plural.toLowerCase()} match “${state.searchRaw.trim()}”`;
  } else {
    const noun = all.length === 1 ? config.singular.toLowerCase() : config.plural.toLowerCase();
    els.listStatus.textContent = `${formatCount(all.length)} ${noun} · ${formatCount(
      state.total,
    )} concerts`;
  }
}

function setDrill(back, backAria, kicker, title, placeholder) {
  els.drillBack.textContent = `\u2190 ${back}`;
  els.drillBack.setAttribute('aria-label', backAria);
  els.drillKicker.textContent = kicker;
  els.drillTitle.textContent = title;
  els.search.placeholder = placeholder;
}

function renderCity(view) {
  if (view === 'shows') {
    const city = selectedCityNode();
    if (!city) {
      state.city.city = null;
      render();
      return;
    }
    const country = findCountry(state.city.country);
    const region = selectedRegion();
    setDrill(
      'Cities',
      'Back to cities',
      [country?.label, region?.label].filter(Boolean).join(' · '),
      city.label,
      'Filter these shows…',
    );
    renderShows(city, { where: 'in' });
    return;
  }

  const level = cityLevel();

  if (level === 'country') {
    setDrill('All filters', 'Back to all filters', 'Browse by', 'Countries', 'Filter countries…');
    renderCityPicker(cityCountries, 'Country', 'Countries');
    return;
  }

  const country = findCountry(state.city.country);
  if (!country) {
    state.city = { country: null, region: null, city: null };
    render();
    return;
  }

  if (level === 'region') {
    setDrill(
      'Countries',
      'Back to countries',
      'Country',
      country.label,
      'Filter states & provinces…',
    );
    renderCityPicker([...country.regions.values()], 'State / Province', 'States & provinces');
    return;
  }

  const region = selectedRegion();
  const nodes = region ? [...region.cities.values()] : [...country.cities.values()];
  const context = region ? region.label : country.label;
  setDrill(
    region ? 'States & provinces' : 'Countries',
    `Back to ${region ? 'states & provinces' : 'countries'}`,
    context,
    'Cities',
    'Filter cities…',
  );
  renderCityPicker(nodes, 'City', 'Cities');
}

/* ---------------------------------------------------------------- songs */

function songEmptyState(message) {
  const empty = document.createElement('li');
  empty.className = 'empty-state';
  empty.textContent = message;
  return empty;
}

function clearListError() {
  showListError(null);
  listRetryAction = loadCatalog;
}

function loadSongs({ force = false } = {}) {
  if (state.song.loading || (state.song.loaded && !force)) return;

  state.song.loading = true;
  state.song.error = null;
  clearListError();
  if (state.dimension === 'song') render();

  fetchSongbook()
    .then((songs) => {
      state.song.list = songs;
      state.song.loaded = true;
    })
    .catch((error) => {
      state.song.error = error?.message ?? 'Could not load the songbook.';
      state.song.loaded = false;
      listRetryAction = () => loadSongs({ force: true });
      showListError(state.song.error);
    })
    .finally(() => {
      state.song.loading = false;
      if (state.dimension === 'song') {
        // A linked view waits for the songbook before selecting its song.
        if (pendingSongKey) {
          const key = pendingSongKey;
          pendingSongKey = null;
          selectSong(key);
        }
        render();
      }
    });
}

function loadSongShows(song, { force = false } = {}) {
  if (!song) return;

  songShowsController?.abort();
  songShowsController = new AbortController();
  const { signal } = songShowsController;

  state.song.selectedKey = song.key;
  state.song.selectedName = song.label;
  state.song.selectedSlugs = song.slugs;
  state.song.shows = [];
  state.song.totalShows = 0;
  state.song.showsLoading = true;
  state.song.showsError = null;
  state.visible = PAGE_SIZE;
  resetSearch();
  clearListError();
  render();
  revealDrillTop();

  const pending = song.slugs.map((slug) => {
    if (!force && songShowsCache.has(slug)) return songShowsCache.get(slug);
    return fetchSongShows(slug, { signal }).then((result) => {
      songShowsCache.set(slug, result);
      return result;
    });
  });

  Promise.allSettled(pending)
    .then((settled) => {
      if (signal.aborted || state.song.selectedKey !== song.key) return;

      const results = settled
        .filter((entry) => entry.status === 'fulfilled')
        .map((entry) => entry.value);
      if (!results.length) {
        const failure = settled.find((entry) => entry.status === 'rejected');
        throw failure?.reason ?? new Error('Could not load this song’s history.');
      }

      // Several upstream slugs can represent the same song; merge them by date
      // so a show that played it once is listed once.
      const byDate = new Map();
      for (const result of results) {
        for (const performance of result.shows) {
          if (!byDate.has(performance.date)) byDate.set(performance.date, performance);
        }
      }

      const catalogByDate = new Map(state.shows.map((show) => [show.date, show]));
      const matches = new Map();
      for (const date of byDate.keys()) {
        const show = catalogByDate.get(date);
        if (show) matches.set(show.id, show);
      }

      state.song.shows = [...matches.values()].sort((a, b) => {
        if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
        return 0;
      });
      state.song.totalShows = byDate.size;
      state.song.showsLoading = false;
      state.song.showsError = null;
      clearListError();
      render();
    })
    .catch((error) => {
      if (signal.aborted || error?.name === 'AbortError' || state.song.selectedKey !== song.key) {
        return;
      }
      state.song.showsError = error?.message ?? 'Could not load this song’s history.';
      state.song.showsLoading = false;
      listRetryAction = () => loadSongShows(song, { force: true });
      showListError(state.song.showsError);
      render();
    });
}

function renderSong(view) {
  if (view === 'shows') {
    setDrill(
      'Songs',
      'Back to songs',
      'Song',
      state.song.selectedName || 'Song',
      'Filter these shows…',
    );
    renderSongShows();
    return;
  }

  setDrill('All filters', 'Back to all filters', 'Browse by', 'Songs', 'Filter songs…');
  renderSongPicker();
}

function renderSongPicker() {
  const all = state.song.list;
  const matches = filterGroupList(all);
  const fragment = document.createDocumentFragment();

  if (state.song.loading) {
    fragment.append(songEmptyState('Loading the Relisten songbook…'));
  } else if (state.song.error) {
    fragment.append(songEmptyState('Could not load the Relisten songbook. Try again.'));
  } else if (!matches.length) {
    fragment.append(
      songEmptyState(
        state.query
          ? `No songs match “${state.searchRaw.trim()}”.`
          : 'No songs in the songbook yet.',
      ),
    );
  } else {
    for (const song of matches) fragment.append(createPickerItem(song, true));
  }

  els.pickerList.replaceChildren(fragment);

  if (state.song.loading) {
    els.listStatus.textContent = 'Loading every song in the Relisten songbook…';
  } else if (state.song.error) {
    els.listStatus.textContent = 'Songbook unavailable.';
  } else if (state.query) {
    els.listStatus.textContent = `${formatCount(matches.length)} of ${formatCount(
      all.length,
    )} songs match “${state.searchRaw.trim()}”`;
  } else {
    els.listStatus.textContent = `${formatCount(all.length)} songs from Relisten · pick one to see its shows`;
  }
}

function renderSongShows() {
  if (state.song.showsLoading) {
    els.showList.replaceChildren(
      songEmptyState(`Finding every show that played “${state.song.selectedName}”…`),
    );
    els.listStatus.textContent = 'Searching the song history…';
    els.loadMore.hidden = true;
    els.listEnd.hidden = true;
    return;
  }

  if (state.song.showsError) {
    els.showList.replaceChildren(songEmptyState('Could not load this song’s history.'));
    els.listStatus.textContent = 'Song history unavailable.';
    els.loadMore.hidden = true;
    els.listEnd.hidden = true;
    return;
  }

  const group = { label: state.song.selectedName, shows: state.song.shows };
  const total = state.song.totalShows;

  if (!group.shows.length) {
    const message = total
      ? `Relisten lists ${formatCount(total)} shows for “${group.label}”, but none are in this stream-only vault.`
      : `Relisten has no shows for “${group.label}”.`;
    els.showList.replaceChildren(songEmptyState(message));
    els.listStatus.textContent = total
      ? `0 of ${formatCount(total)} shows available in the vault`
      : 'No shows found.';
    els.loadMore.hidden = true;
    els.listEnd.hidden = true;
    return;
  }

  renderShows(group, { where: 'with' });
  if (!state.query && total > group.shows.length) {
    els.listStatus.textContent += ` · ${formatCount(group.shows.length)} of ${formatCount(
      total,
    )} shows are in the vault`;
  }
}

function renderCityPicker(nodes, singular, plural) {
  const all = sortedNodes(nodes);
  const matches = filterGroupList(all);
  const fragment = document.createDocumentFragment();

  if (!matches.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = state.query
      ? `No ${plural.toLowerCase()} match “${state.searchRaw.trim()}”.`
      : `No ${plural.toLowerCase()} in the vault yet.`;
    fragment.append(empty);
  }

  for (const group of matches) {
    fragment.append(createPickerItem(group, true));
  }

  els.pickerList.replaceChildren(fragment);

  const scope = all.reduce((total, group) => total + group.shows.length, 0);
  if (state.query) {
    els.listStatus.textContent = `${formatCount(matches.length)} of ${formatCount(
      all.length,
    )} ${plural.toLowerCase()} match “${state.searchRaw.trim()}”`;
  } else {
    const noun = all.length === 1 ? singular.toLowerCase() : plural.toLowerCase();
    els.listStatus.textContent = `${formatCount(all.length)} ${noun} · ${formatCount(
      scope,
    )} concerts`;
  }
}

function renderShows(group, config) {
  const matches = filteredGroupShows(group);
  const visible = matches.slice(0, state.visible);
  const fragment = document.createDocumentFragment();

  if (!visible.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = state.query
      ? `No shows match “${state.searchRaw.trim()}”.`
      : 'No shows here yet.';
    fragment.append(empty);
  }

  for (const show of visible) {
    fragment.append(createShowItem(show));
  }

  els.showList.replaceChildren(fragment);

  const remaining = matches.length - visible.length;
  if (state.query) {
    els.listStatus.textContent = `${formatCount(matches.length)} matching · showing ${formatCount(
      visible.length,
    )}`;
  } else {
    const noun = group.shows.length === 1 ? 'concert' : 'concerts';
    els.listStatus.textContent = `${formatCount(group.shows.length)} ${noun} ${config.where} ${
      group.label
    } · newest first`;
  }

  els.loadMore.hidden = remaining <= 0;
  els.loadMore.disabled = state.loading;
  els.loadMore.textContent = 'Load more shows';
  els.listEnd.hidden = remaining > 0 || matches.length === 0 || state.loading;
}

function createShowItem(show) {
  const item = document.createElement('li');
  item.className = 'show-item';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'show';
  button.dataset.id = show.id;
  const accent = activeTheme.colors[hash(show.id) % activeTheme.colors.length];
  button.style.setProperty('--accent', accent);
  button.style.setProperty('--accent-ink', readableInk(accent));
  button.classList.toggle('is-active', show.id === state.selectedId);

  const parts = isoParts(show.date);

  const date = document.createElement('span');
  date.className = 'show-date';
  const month = document.createElement('span');
  month.className = 'show-month';
  month.textContent = parts ? monthAbbr(parts.month) : '—';
  const day = document.createElement('span');
  day.className = 'show-day';
  day.textContent = parts ? String(parts.day).padStart(2, '0') : '··';
  const year = document.createElement('span');
  year.className = 'show-year';
  year.textContent = parts ? String(parts.year) : '????';
  date.append(month, day, year);

  const body = document.createElement('span');
  body.className = 'show-body';

  const title = document.createElement('span');
  title.className = 'show-title';
  title.textContent = show.title;

  const meta = document.createElement('span');
  meta.className = 'show-meta';
  if (show.coverage) {
    const place = document.createElement('span');
    place.textContent = show.coverage;
    meta.append(place);
  }
  if (show.source) {
    const tag = document.createElement('span');
    tag.className = `source-tag source-${show.source.toLowerCase()}`;
    tag.textContent = show.source;
    meta.append(tag);
  }
  body.append(title, meta);

  const side = document.createElement('span');
  side.className = 'show-side';
  const plays = document.createElement('span');
  plays.className = 'show-plays';
  plays.textContent = formatCompact(show.views);
  plays.title = `${formatCount(show.views)} all-time views on Archive.org`;
  const glyph = document.createElement('span');
  glyph.className = 'show-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.innerHTML = TRACKLIST_ICON;
  side.append(plays, glyph);

  button.append(date, body, side);
  button.setAttribute(
    'aria-label',
    `${formatLongDate(show.date)}${show.venue ? ` at ${show.venue}` : ''}${
      show.coverage ? `, ${show.coverage}` : ''
    }`,
  );
  item.append(button);
  return item;
}


function showListError(message) {
  els.listAlert.hidden = !message;
  els.listAlertMsg.textContent = message ?? '';
}

async function loadCatalog() {
  if (state.loading) return;
  state.loading = true;
  clearListError();
  els.listSkeleton.hidden = false;
  render();

  try {
    const { shows, total, recordings } = await fetchCatalog();
    state.shows = shows;
    state.total = total;
    state.recordings = recordings;
    state.visible = PAGE_SIZE;
    for (const dimension of Object.keys(DIMENSIONS).filter((key) => DIMENSIONS[key].pick)) {
      groups[dimension] = buildGroups(shows, dimension);
    }
    buildCityTree(shows);
  } catch (error) {
    showListError(error?.message ?? 'Could not reach Archive.org.');
  } finally {
    state.loading = false;
    els.listSkeleton.hidden = true;
    render();
    if (state.shows.length) restoreFromUrl();
    if (state.shows.length) restoreSession();
  }
}

async function restoreSession() {
  if (sessionRestored) return;
  sessionRestored = true;

  const session = loadSession();
  if (!session) return;

  const show = state.shows.find((entry) => entry.id === session.showId);
  if (!show) {
    clearSession();
    return;
  }

  const epoch = restoreEpoch;
  try {
    const { tracks } = await fetchShowTracks(show.id);
    if (epoch !== restoreEpoch || state.selectedId) return;

    let index = tracks.findIndex((track) => track.id === session.trackId);
    if (index < 0 && tracks[session.trackIndex]) index = session.trackIndex;
    if (index < 0) {
      clearSession();
      return;
    }

    state.selectedId = show.id;
    state.show = show;
    state.tracks = tracks;
    populatePanel(show);
    els.panelPlay.disabled = !tracks.length;
    renderTracks();
    els.trackSkeleton.hidden = true;
    player.restore(show, tracks, index, session.time);
    rememberShow(show);
    setPanelNote('Picked up where you left off.');
  } catch {
    /* Leave the session saved; the next visit can try again. */
  }
}

function revealMore() {
  if (state.loading) return;
  state.visible += PAGE_SIZE;
  render();
}

function resetSearch() {
  state.query = '';
  state.searchRaw = '';
  els.search.value = '';
  els.searchClear.hidden = true;
}

function resetTrackSearch() {
  state.trackQuery = '';
  state.trackSearchRaw = '';
  els.trackSearch.value = '';
  els.trackSearchClear.hidden = true;
}

function setDimension(dimension, { reveal = true } = {}) {
  if (dimension !== 'city' && dimension !== 'song' && !DIMENSIONS[dimension]) return;
  songShowsController?.abort();
  clearListError();
  state.dimension = dimension;
  state.value = null;
  state.city = { country: null, region: null, city: null };
  state.visible = PAGE_SIZE;

  if (dimension === 'history') {
    groups.history = buildHistoryGroup(state.shows);
    state.value = groups.history[0].key;
  }

  if (dimension === 'song') {
    state.song.selectedKey = null;
    state.song.selectedName = '';
    state.song.selectedSlugs = [];
    state.song.shows = [];
    state.song.totalShows = 0;
    state.song.showsLoading = false;
    state.song.showsError = null;
  }

  resetSearch();
  if (dimension === 'song') loadSongs();
  render();
  if (reveal) revealDrillTop();
}

function selectGroup(key) {
  clearListError();
  state.value = key;
  state.visible = PAGE_SIZE;
  resetSearch();
  render();
  revealDrillTop();
}

function selectSong(key) {
  const song = state.song.list.find((entry) => entry.key === key);
  if (song) loadSongShows(song);
}

function selectCityNode(key) {
  clearListError();
  const level = cityLevel();

  if (level === 'country') {
    state.city = { country: key, region: null, city: null };
  } else if (level === 'region') {
    state.city.region = key;
    state.city.city = null;
  } else if (level === 'city') {
    state.city.city = key;
  }

  state.visible = PAGE_SIZE;
  resetSearch();
  render();
  revealDrillTop();
}

function revealDrillTop() {
  const anchor = els.searchWrap.hidden ? els.catalogChoices : els.searchWrap;
  anchor.scrollIntoView({ block: 'start' });
  els.drillTitle.focus({ preventScroll: true });
}

function goBack() {
  clearListError();

  if (state.dimension === 'song') {
    songShowsController?.abort();

    if (state.song.selectedKey) {
      state.song.selectedKey = null;
      state.song.selectedName = '';
      state.song.selectedSlugs = [];
      state.song.shows = [];
      state.song.totalShows = 0;
      state.song.showsLoading = false;
      state.song.showsError = null;
      state.visible = PAGE_SIZE;
      resetSearch();
      render();
      revealDrillTop();
      return;
    }

    state.dimension = null;
    state.visible = PAGE_SIZE;
    resetSearch();
    render();
    els.choiceButtons.find((button) => button.dataset.dimension === 'song')?.focus();
    return;
  }

  if (state.dimension === 'city') {
    goBackCity();
    return;
  }

  if (state.value != null && state.dimension !== 'history') {
    state.value = null;
    state.visible = PAGE_SIZE;
    resetSearch();
    render();
    revealDrillTop();
    return;
  }

  if (!state.dimension) return;

  const dimension = state.dimension;
  state.dimension = null;
  state.visible = PAGE_SIZE;
  resetSearch();
  render();
  els.choiceButtons.find((button) => button.dataset.dimension === dimension)?.focus();
}

function goBackCity() {
  const level = cityLevel();
  state.visible = PAGE_SIZE;
  resetSearch();

  if (level === 'shows') {
    state.city.city = null;
    render();
    revealDrillTop();
    return;
  }

  if (level === 'city') {
    const country = findCountry(state.city.country);
    if (country?.hasRegions) state.city.region = null;
    else state.city = { country: null, region: null, city: null };
    render();
    revealDrillTop();
    return;
  }

  if (level === 'region') {
    state.city = { country: null, region: null, city: null };
    render();
    revealDrillTop();
    return;
  }

  state.dimension = null;
  state.city = { country: null, region: null, city: null };
  render();
  els.choiceButtons.find((button) => button.dataset.dimension === 'city')?.focus();
}

/* ------------------------------------------------------------ track panel */

function syncPanelMode() {
  const isOpen = els.panel.classList.contains('is-open');
  const overlay = mobileQuery.matches && isOpen;
  els.panelBackdrop.hidden = !overlay;
  document.body.classList.toggle('panel-locked', overlay);
}

function openPanel() {
  els.panel.classList.add('is-open');
  syncPanelMode();
  if (mobileQuery.matches) els.panelClose.focus({ preventScroll: true });
}

function closePanel() {
  els.panel.classList.remove('is-open');
  syncPanelMode();
}

function setPanelNote(message, isError = false) {
  els.panelNote.textContent = message ?? '';
  els.panelNote.classList.toggle('is-error', Boolean(message) && isError);
}

function populatePanel(show) {
  els.panelEmpty.hidden = true;
  els.panelContent.hidden = false;
  els.panelDate.textContent = formatShortDate(show.date) || 'Date unknown';
  els.panelTitle.textContent = show.title;
  els.panelVenue.textContent = [show.coverage, show.source && `${show.source} recording`]
    .filter(Boolean)
    .join(' · ');
  els.panelLink.href = show.detailsUrl;
  els.panelPlay.disabled = true;
  resetTrackSearch();
  els.trackSearchWrap.hidden = true;
  els.trackSearchStatus.textContent = '';
  els.trackList.replaceChildren();
  els.trackSkeleton.hidden = false;
  setPanelNote('');
}

async function selectShow(showId) {
  const show = state.shows.find((entry) => entry.id === showId);
  if (!show) return;

  state.selectedId = showId;
  state.show = show;
  state.tracks = [];
  rememberShow(show);

  for (const button of els.showList.querySelectorAll('.show')) {
    button.classList.toggle('is-active', button.dataset.id === showId);
  }

  openPanel();
  populatePanel(show);

  panelRequest?.abort();
  panelRequest = new AbortController();
  state.tracksLoading = true;

  try {
    const { tracks } = await fetchShowTracks(show.id, { signal: panelRequest.signal });
    if (state.selectedId !== showId) return;

    state.tracks = tracks;
    els.panelPlay.disabled = !tracks.length;
    renderTracks();

    const firstPlayable = tracks.findIndex((track) => !track.unavailable);
    if (firstPlayable >= 0) {
      if (output.mode === 'sonos') playOnSonos(show, tracks, firstPlayable);
      else player.playShow(show, tracks, firstPlayable, true);
    } else {
      setPanelNote('This recording has no playable tracks.', true);
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    setPanelNote(error?.message ?? 'Could not load the setlist.', true);
    els.panelPlay.disabled = true;
  } finally {
    if (state.selectedId === showId) {
      els.trackSkeleton.hidden = true;
      state.tracksLoading = false;
    }
  }
}

function trackSearchLabel(matches, total) {
  const raw = state.trackSearchRaw.trim();
  if (!total) return '';
  if (state.trackQuery) {
    return `${formatCount(matches)} of ${formatCount(total)} songs ${
      matches === 1 ? 'matches' : 'match'
    } “${raw}”`;
  }
  if (raw && raw.length < MIN_SEARCH_LENGTH) {
    const remaining = MIN_SEARCH_LENGTH - raw.length;
    return `${formatCount(total)} songs · type ${remaining} more character${
      remaining === 1 ? '' : 's'
    } to search`;
  }
  return `${formatCount(total)} ${total === 1 ? 'song' : 'songs'}`;
}

function renderTracks() {
  const current = activeSnapshot();
  const currentId = current.context?.id === state.selectedId ? current.track?.id : null;
  const fragment = document.createDocumentFragment();
  const query = state.trackQuery;
  const entries = state.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => !query || track.title.toLowerCase().includes(query));

  if (!entries.length && state.tracks.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = `No songs match “${state.trackSearchRaw.trim()}”.`;
    fragment.append(empty);
  }

  for (const { track, index } of entries) {
    const item = document.createElement('li');
    item.className = 'track-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'track-button';
    button.dataset.trackId = track.id;
    button.dataset.index = String(index);
    button.classList.toggle('is-current', track.id === currentId);
    if (track.id === currentId) button.setAttribute('aria-current', 'true');
    if (track.unavailable) button.classList.add('is-unavailable');

    const number = document.createElement('span');
    number.className = 'track-num';
    number.textContent = String(index + 1).padStart(2, '0');

    const title = document.createElement('span');
    title.className = 'track-title';
    title.textContent = track.title;

    const eq = document.createElement('span');
    eq.className = 'eq';
    eq.setAttribute('aria-hidden', 'true');
    eq.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));

    const duration = document.createElement('span');
    duration.className = 'track-dur';
    duration.textContent = track.unavailable ? 'n/a' : formatClock(track.duration);

    const label = `${track.title}${track.duration ? `, ${formatClock(track.duration)}` : ''}${
      track.unavailable ? ', unavailable' : ''
    }`;

    button.append(number, title, eq, duration);
    button.setAttribute('aria-label', label);
    item.append(button);
    fragment.append(item);
  }

  els.trackList.replaceChildren(fragment);
  els.trackSearchWrap.hidden = !state.tracks.length;
  els.trackSearchStatus.textContent = trackSearchLabel(entries.length, state.tracks.length);
  els.panel.classList.toggle('is-paused', !current.playing);
}

function playTrack(index) {
  const track = state.tracks[index];
  if (!track || !state.show) return;

  const current = activeSnapshot();
  if (current.context?.id === state.show.id && current.track?.id === track.id) {
    toggleOutput();
    return;
  }
  if (output.mode === 'sonos') playOnSonos(state.show, state.tracks, index);
  else player.playShow(state.show, state.tracks, index, true);
}

function playShowFromStart() {
  const first = state.tracks.findIndex((track) => !track.unavailable);
  if (first >= 0 && state.show) {
    if (output.mode === 'sonos') playOnSonos(state.show, state.tracks, first);
    else player.playShow(state.show, state.tracks, first, true);
  }
}

/* --------------------------------------------------------------- transport */

function saveCurrentSession(snapshot, force = false) {
  if (!snapshot.track || !snapshot.context) return;

  const now = Date.now();
  if (!force && now - sessionSavedAt < 4000) return;
  sessionSavedAt = now;

  let time = Number(snapshot.currentTime) || 0;
  if (snapshot.duration > 0 && time >= snapshot.duration - 1) time = 0;

  saveSession({
    showId: snapshot.context.id,
    showTitle: snapshot.context.title ?? '',
    showDate: snapshot.context.date ?? null,
    trackId: snapshot.track.id,
    trackIndex: snapshot.index,
    trackTitle: snapshot.track.title ?? '',
    time,
  });
}

function updateProgress(snapshot) {
  if (!snapshot.track) {
    els.npCurrent.textContent = '0:00';
    els.npDuration.textContent = '0:00';
    els.npSeek.value = '0';
    setRangeFill(els.npSeek);
    return;
  }
  const duration = Math.max(1, Math.round(snapshot.duration || 0));
  els.npSeek.max = String(duration);
  if (!seeking) {
    els.npSeek.value = String(Math.min(Math.round(snapshot.currentTime), duration));
    els.npCurrent.textContent = formatClock(snapshot.currentTime);
  }
  els.npDuration.textContent = formatClock(snapshot.duration);
  setRangeFill(els.npSeek);
}

/**
 * Show the gapless handoff in the transport: the next track is fetched in the last
 * 30 seconds of the current one, so surface that it is buffering, then ready.
 */
let preloadLabel = null;

function renderPreload(snapshot) {
  const preload = snapshot.preload;
  const label = !preload
    ? ''
    : preload.ready
      ? 'Next track ready'
      : 'Buffering next…';
  if (label === preloadLabel) return;
  preloadLabel = label;

  els.npPreload.hidden = !label;
  els.npPreload.textContent = label;
  if (label) els.npPreload.dataset.state = preload.ready ? 'ready' : 'buffering';
  else delete els.npPreload.dataset.state;
}

function renderTransport(snapshot) {
  const hasTrack = Boolean(snapshot.track);
  document.querySelector('.np-label').textContent = output.mode === 'sonos'
    ? `Now playing · ${selectedRoomNames().join(' + ') || 'Sonos'}`
    : 'Now playing';
  els.npTrack.textContent = snapshot.track?.title ?? 'Nothing yet';
  els.npShow.textContent = snapshot.context
    ? [snapshot.context.title, formatShortDate(snapshot.context.date)].filter(Boolean).join(' · ')
    : 'Pick a show to start';
  els.npToggle.disabled = !hasTrack;
  els.npPrev.disabled = !snapshot.hasPrev;
  els.npNext.disabled = !snapshot.hasNext;
  els.npStop.hidden = output.mode !== 'sonos';
  els.npStop.disabled = !hasTrack;
  els.npSeek.disabled = !hasTrack;
  els.npToggle.innerHTML = snapshot.playing ? PAUSE_ICON : PLAY_ICON;
  els.npToggle.setAttribute('aria-label', snapshot.playing ? 'Pause' : 'Play');
  document.body.classList.toggle('is-playing', snapshot.playing);
  renderPreload(snapshot);
  updateProgress(snapshot);
}

function highlightTracks(snapshot) {
  const isSameShow = snapshot.context?.id === state.selectedId;
  const currentId = isSameShow ? snapshot.track?.id : null;

  for (const button of els.trackList.querySelectorAll('.track-button')) {
    const isCurrent = currentId != null && button.dataset.trackId === currentId;
    button.classList.toggle('is-current', isCurrent);
    if (isCurrent) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  els.panel.classList.toggle('is-paused', !snapshot.playing);
}

player.on((type, snapshot) => {
  if (output.mode === 'sonos') {
    if (type === 'volume') saveSettings({ volume: snapshot.volume });
    return;
  }
  if (type === 'time') {
    // Priming happens on the same tick as a time update, so refresh the label here.
    renderPreload(snapshot);
    updateProgress(snapshot);
    saveCurrentSession(snapshot);
    return;
  }
  if (type === 'preload') {
    renderPreload(snapshot);
    return;
  }
  if (type === 'playpause') {
    renderTransport(snapshot);
    highlightTracks(snapshot);
    saveCurrentSession(snapshot, true);
    return;
  }
  if (type === 'volume') {
    els.npVolume.value = String(snapshot.volume);
    setRangeFill(els.npVolume);
    const now = Date.now();
    if (now - settingsSavedAt >= 250) {
      settingsSavedAt = now;
      saveSettings({ volume: snapshot.volume });
    }
    return;
  }

  renderTransport(snapshot);
  highlightTracks(snapshot);

  if (type === 'track') {
    rememberShow(snapshot.context);
    return;
  }

  if (type === 'error') {
    setPanelNote(snapshot.error, true);
    if (snapshot.context?.id === state.selectedId) renderTracks();
  }
});

/* -------------------------------------------------------------- listeners */

els.showList.addEventListener('click', (event) => {
  const button = event.target.closest('.show');
  if (button?.dataset.id) selectShow(button.dataset.id);
});

els.loadMore.addEventListener('click', revealMore);
els.listRetry.addEventListener('click', () => listRetryAction());
els.drillBack.addEventListener('click', goBack);

els.catalogChoices.addEventListener('click', (event) => {
  const button = event.target.closest('[data-dimension]');
  if (button?.dataset.dimension) setDimension(button.dataset.dimension);
});

els.pickerList.addEventListener('click', (event) => {
  const button = event.target.closest('.picker-item');
  if (!button?.dataset.key) return;
  if (state.dimension === 'city') selectCityNode(button.dataset.key);
  else if (state.dimension === 'song') selectSong(button.dataset.key);
  else selectGroup(button.dataset.key);
});
els.panelPlay.addEventListener('click', playShowFromStart);
els.panelClose.addEventListener('click', closePanel);
els.panelBackdrop.addEventListener('click', closePanel);
els.panelLink.addEventListener('click', (event) => {
  if (!isTauri()) return;
  event.preventDefault();
  openUrl(els.panelLink.href).catch(() => {
    setPanelNote('Could not open Archive.org in your browser.', true);
  });
});

els.trackList.addEventListener('click', (event) => {
  const button = event.target.closest('.track-button');
  if (button) playTrack(Number(button.dataset.index));
});

els.search.addEventListener('input', () => {
  state.searchRaw = els.search.value;
  state.query = normalizeSearch(state.searchRaw);
  state.visible = PAGE_SIZE;
  els.searchClear.hidden = !state.searchRaw;
  render();
});

els.searchClear.addEventListener('click', () => {
  resetSearch();
  state.visible = PAGE_SIZE;
  render();
  els.search.focus();
});

els.trackSearch.addEventListener('input', () => {
  state.trackSearchRaw = els.trackSearch.value;
  state.trackQuery = normalizeSearch(state.trackSearchRaw);
  els.trackSearchClear.hidden = !state.trackSearchRaw;
  renderTracks();
});

els.trackSearchClear.addEventListener('click', () => {
  resetTrackSearch();
  renderTracks();
  els.trackSearch.focus();
});

els.npToggle.addEventListener('click', toggleOutput);
els.npNext.addEventListener('click', nextOutput);
els.npPrev.addEventListener('click', previousOutput);

els.npSeek.addEventListener('input', () => {
  seeking = true;
  els.npCurrent.textContent = formatClock(Number(els.npSeek.value));
  setRangeFill(els.npSeek);
});
els.npSeek.addEventListener('change', () => {
  if (output.mode === 'sonos') {
    output.sonos.currentTime = Number(els.npSeek.value);
    sonosControl('seek', output.sonos.currentTime);
  } else player.seek(Number(els.npSeek.value));
  seeking = false;
});

els.npVolume.addEventListener('input', () => {
  if (output.mode === 'sonos') {
    output.sonos.volume = Number(els.npVolume.value);
    window.clearTimeout(sonosVolumeTimer);
    sonosVolumeTimer = window.setTimeout(() => {
      sonosControl('volume', Math.round(output.sonos.volume * 100));
    }, 140);
  } else player.setVolume(Number(els.npVolume.value));
  setRangeFill(els.npVolume);
});
els.npVolume.addEventListener('change', () => {
  if (output.mode === 'local') saveSettings({ volume: player.snapshot().volume });
});

els.npOutputMode.addEventListener('change', () => chooseOutput(els.npOutputMode.value));
els.npSonosRefresh.addEventListener('click', refreshSonosRooms);
els.npSonosRooms.addEventListener('change', updateRoomSelection);
els.npStop.addEventListener('click', stopSonos);

els.recentList.addEventListener('click', (event) => {
  const button = event.target.closest('.recent-item');
  if (button?.dataset.id) selectShow(button.dataset.id);
});
els.recentClear.addEventListener('click', () => {
  clearRecentShows();
  recentShows = [];
  render();
});

/* ------------------------------------------------------------------ themes */

function buildThemeOptions() {
  const fragment = document.createDocumentFragment();

  for (const theme of THEMES) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'theme-option';
    option.dataset.themeId = theme.id;
    option.setAttribute('aria-pressed', 'false');
    option.setAttribute('aria-label', `${theme.name} theme`);

    const swatches = document.createElement('span');
    swatches.className = 'theme-swatches';
    swatches.setAttribute('aria-hidden', 'true');
    for (const color of theme.colors) {
      const dot = document.createElement('i');
      dot.style.backgroundColor = color;
      swatches.append(dot);
    }

    const name = document.createElement('span');
    name.className = 'theme-option-name';
    name.textContent = theme.name;

    const check = document.createElement('span');
    check.className = 'theme-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '\u2713';

    option.append(swatches, name, check);
    fragment.append(option);
  }

  els.themeOptions.replaceChildren(fragment);
}

function syncThemeControls() {
  const dots = els.themeSwatches.querySelectorAll('i');
  dots.forEach((dot, index) => {
    dot.style.backgroundColor = activeTheme.colors[index] ?? 'transparent';
  });

  els.themeLabel.textContent = activeTheme.name;
  els.themeButton.setAttribute('aria-label', `Color theme: ${activeTheme.name}. Change theme`);

  for (const option of els.themeOptions.querySelectorAll('[data-theme-id]')) {
    option.setAttribute('aria-pressed', String(option.dataset.themeId === activeTheme.id));
  }
}

function applyTheme(id, { persist = false, rerender = false } = {}) {
  const theme = getTheme(id);
  const root = document.documentElement;

  activeTheme = theme;
  theme.colors.forEach((color, index) => {
    root.style.setProperty(`--theme-${index + 1}`, color);
  });
  // Text inks are the palette colors lifted to a readable lightness; the raw colors
  // stay untouched for fills, borders, and gradients.
  themeInks(theme.colors).forEach((ink, index) => {
    root.style.setProperty(`--theme-${index + 1}-ink`, ink);
  });
  root.style.setProperty('--theme-action', themeActionColor(theme.colors));
  root.style.setProperty('--accent-text', chooseAccentText(theme.colors));
  root.dataset.theme = theme.id;
  // Keep browser/OS chrome on the theme background instead of a static guess.
  themeColorMeta?.setAttribute('content', themeBackground(theme.colors));

  syncThemeControls();
  if (persist) saveSettings({ theme: theme.id });
  if (rerender) render();
}

function setThemeMenu(open, { restoreFocus = false } = {}) {
  els.themeMenu.hidden = !open;
  els.themeButton.setAttribute('aria-expanded', String(open));

  if (open) {
    setResetMenu(false);
    const selected = [...els.themeOptions.querySelectorAll('[data-theme-id]')].find(
      (option) => option.dataset.themeId === activeTheme.id,
    );
    (selected ?? els.themeOptions.firstElementChild)?.focus();
  } else if (restoreFocus) {
    els.themeButton.focus();
  }
}

function selectTheme(id) {
  if (getTheme(id).id !== activeTheme.id) applyTheme(id, { persist: true, rerender: true });
  setThemeMenu(false, { restoreFocus: true });
}

els.themeButton.addEventListener('click', () => {
  setThemeMenu(els.themeMenu.hidden, { restoreFocus: !els.themeMenu.hidden });
});

els.themeOptions.addEventListener('click', (event) => {
  const option = event.target.closest('[data-theme-id]');
  if (option?.dataset.themeId) selectTheme(option.dataset.themeId);
});

els.themeOptions.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

  const options = [...els.themeOptions.querySelectorAll('.theme-option')];
  const current = options.indexOf(document.activeElement);
  let next = current;

  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = options.length - 1;
  else if (event.key === 'ArrowDown') next = (current + 1) % options.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + options.length) % options.length;

  if (next !== current) {
    event.preventDefault();
    options[next].focus();
  }
});

/* ------------------------------------------------------------- reset data */

let resetStatusTimer = null;

function setResetMenu(open, { restoreFocus = false } = {}) {
  els.resetMenu.hidden = !open;
  els.resetData.setAttribute('aria-expanded', String(open));
  if (open) {
    setThemeMenu(false);
    els.resetConfirm.focus();
  } else if (restoreFocus) {
    els.resetData.focus();
  }
}

function showResetStatus(message) {
  els.resetStatus.textContent = message;
  els.resetStatus.hidden = !message;
  clearTimeout(resetStatusTimer);
  if (message) {
    resetStatusTimer = setTimeout(() => {
      els.resetStatus.hidden = true;
    }, 4000);
  }
}

function clearPanelSelection() {
  panelRequest?.abort();
  panelRequest = null;
  state.tracksLoading = false;
  state.selectedId = null;
  state.show = null;
  state.tracks = [];
  resetTrackSearch();
  els.panelContent.hidden = true;
  els.panelEmpty.hidden = false;
  els.panelPlay.disabled = true;
  els.trackList.replaceChildren();
  els.trackSearchWrap.hidden = true;
  els.trackSearchStatus.textContent = '';
  els.trackSkeleton.hidden = true;
  closePanel();
}

function resetPersistedData() {
  restoreEpoch += 1;
  player.stop();
  if (output.mode === 'sonos' && output.roomId) sonosControl('stop');
  for (const followerId of output.roomIds.slice(1)) {
    void invoke('sonos_player_leave', { playerId: followerId }).catch(() => {});
  }
  output.mode = 'local';
  els.npOutputMode.value = 'local';
  els.npSonosRooms.hidden = true;
  output.roomIds = [];
  output.roomId = '';
  output.selectionLocked = false;
  renderRoomChoices();
  renderTransport(player.snapshot());
  clearPanelSelection();
  clearAllData();
  recentShows = [];
  sessionRestored = true;
  sessionSavedAt = 0;

  // Reset theme and volume to their defaults, then remove the settings that change wrote.
  applyTheme(DEFAULT_THEME_ID, { persist: false, rerender: false });
  player.setVolume(loadSettings().volume);
  clearAllData();

  render();
  setThemeMenu(false);
  setResetMenu(false);
  showResetStatus('Saved data and theme reset.');
  els.resetData.focus();
}

els.resetData.addEventListener('click', () => {
  setResetMenu(els.resetMenu.hidden, { restoreFocus: !els.resetMenu.hidden });
});
els.resetCancel.addEventListener('click', () => setResetMenu(false, { restoreFocus: true }));
els.resetConfirm.addEventListener('click', resetPersistedData);

document.addEventListener('click', (event) => {
  if (!els.resetMenu.hidden && !event.target.closest('.reset-wrap')) setResetMenu(false);
  if (!els.themeMenu.hidden && !event.target.closest('.theme-wrap')) setThemeMenu(false);
});

function persistBeforeExit() {
  saveCurrentSession(player.snapshot(), true);
}
window.addEventListener('pagehide', persistBeforeExit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistBeforeExit();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!els.themeMenu.hidden) setThemeMenu(false, { restoreFocus: true });
    else if (!els.resetMenu.hidden) setResetMenu(false, { restoreFocus: true });
    else if (els.panel.classList.contains('is-open')) closePanel();
    else goBack();
  }
  if (event.code === 'Space' && event.target === document.body && activeSnapshot().track) {
    event.preventDefault();
    toggleOutput();
  }
});

mobileQuery.addEventListener('change', syncPanelMode);

async function setupTauriShell() {
  if (!isTauri()) return;

  try {
    await getCurrentWindow().setTitle(`Grateful Vibes v${__APP_VERSION__}`);
  } catch {
    /* Title sync is cosmetic; never block the shell setup on it. */
  }

  try {
    await onBackButtonPress(() => {
      if (els.panel.classList.contains('is-open')) {
        closePanel();
        return;
      }
      if (state.dimension) {
        goBack();
        return;
      }
      saveCurrentSession(activeSnapshot(), true);
      void exit(0);
    });
  } catch {
    /* Unsupported platform or older Tauri runtime; leave native behavior alone. */
  }
}

/* ------------------------------------------------------------------ boot */

// Keep the page and panel clear of the transport bar at every breakpoint.
const transportObserver = new ResizeObserver(() => {
  const height = Math.ceil(nowPlayingEl.getBoundingClientRect().height);
  if (height) document.documentElement.style.setProperty('--np-h', `${height}px`);
});
transportObserver.observe(nowPlayingEl);

els.brandVersion.textContent = `v${__APP_VERSION__}`;

const bootSettings = loadSettings();
buildThemeOptions();
applyTheme(bootSettings.theme ?? DEFAULT_THEME_ID, { persist: false, rerender: false });
player.setVolume(bootSettings.volume);
output.sonos.volume = bootSettings.volume;
els.npVolume.value = String(player.snapshot().volume);
setRangeFill(els.npVolume);
els.npToggle.innerHTML = PLAY_ICON;
els.panel.classList.add('is-paused');

for (let i = 0; i < 8; i += 1) {
  const row = document.createElement('div');
  row.className = 'skeleton-row';
  els.listSkeleton.append(row);
}

setupTauriShell();
initializeSonos();
loadCatalog();
