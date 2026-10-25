/**
 * User-selectable color themes. Each palette is ordered:
 * primary, secondary, highlight, support, surface tint.
 */
export const THEMES = [
  {
    id: 'scarlet-begonias',
    name: 'Scarlet Begonias',
    colors: ['#d7263d', '#2a9d8f', '#f4c430', '#1b4332', '#f9d5c0'],
  },
  {
    id: 'ripple',
    name: 'Ripple',
    colors: ['#2e86ab', '#8ecae6', '#cfe8ef', '#1d3557', '#e9f5f9'],
  },
  {
    id: 'brown-eyed-women',
    name: 'Brown-Eyed Women',
    colors: ['#8b5a2b', '#c98b4b', '#f0d9b5', '#5c3a1e', '#fff5e1'],
  },
  {
    id: 'shakedown-street',
    name: 'Shakedown Street',
    colors: ['#ff2e88', '#00e5c0', '#8a5cff', '#ff7a3d', '#ffd166'],
  },
  {
    id: 'ship-of-fools',
    name: 'Ship of Fools',
    colors: ['#1f9e8f', '#7fd6c9', '#ff6b9d', '#2c4f5c', '#f3e9d2'],
  },
  {
    id: 'dark-star',
    name: 'Dark Star',
    colors: ['#4c1d95', '#1e1b4b', '#a78bfa', '#0b1026', '#e0e7ff'],
  },
  {
    id: 'the-other-one',
    name: 'The Other One',
    colors: ['#22ff88', '#00c2ff', '#2b2bff', '#b800ff', '#ff3df2'],
  },
  {
    id: 'sugar-magnolia',
    name: 'Sugar Magnolia',
    colors: ['#f4a300', '#ff8fab', '#fff3d6', '#6a8f3c', '#ffe066'],
  },
  {
    id: 'touch-of-grey',
    name: 'Touch of Grey',
    colors: ['#ff2a6d', '#d1f7ff', '#05d9e8', '#005678', '#9aa5b1'],
  },
  {
    id: 'one-more-saturday-night',
    name: 'One More Saturday Night',
    colors: ['#c1121f', '#111111', '#ffffff', '#5f9ea0', '#f5efdc'],
  },
  {
    id: 'truckin',
    name: 'Truckin\'',
    colors: ['#b5179e', '#7b2cbf', '#ff006e', '#ffa600', '#ffb3c6'],
  },
  {
    id: 'casey-jones',
    name: 'Casey Jones',
    colors: ['#eb0000', '#000000', '#FFD700', '#A9A9A9', '#FFFFFF'],
  },
  {
    id: 'i-know-you-rider',
    name: 'I Know You Rider',
    colors: ['#3a6ea5', '#8d5a97', '#e9c46a', '#1d3557', '#f1e3d3'],
  },
  {
    id: 'box-of-rain',
    name: 'Box of Rain',
    colors: ['#4a7c9b', '#35586b', '#89b4c9', '#16222b', '#b8c7cf'],
  },
  {
    id: 'sugaree',
    name: 'Sugaree',
    colors: ['#5f0f40', '#9a031e', '#fb8b24', '#e36414', '#0f4c5c'],
  },
  {
    id: 'loser',
    name: 'Loser',
    colors: ['#1b3b6f', '#3f6d99', '#7fb3d5', '#d9a066', '#e8eef2'],
  },
  {
    id: 'eyes-of-the-world',
    name: 'Eyes of the World',
    colors: ['#2d1b36', '#6a2c70', '#b83b5e', '#f08a5d', '#f9ed69'],
  },
  {
    id: 'attics-of-my-life',
    name: 'Attics of My Life',
    colors: ['#7b2d26', '#c9a227', '#f4ead5', '#2f4858', '#e0d8c3'],
  },
  {
    id: 'terrapin-station',
    name: 'Terrapin Station',
    colors: ['#a16ed5', '#6247aa', '#e8d7f1', '#102542', '#f87060'],
  },
  {
    id: 'bertha',
    name: 'Bertha',
    colors: ['#ff2e63', '#08d9d6', '#ffde22', '#252a34', '#eaeaea'],
  },
  {
    id: 'peggy-o',
    name: 'Peggy-O',
    colors: ['#e07a5f', '#f2cc8f', '#3d405b', '#81b29a', '#f4f1de'],
  },
  {
    id: 'franklins-tower',
    name: 'Franklin\'s Tower',
    colors: ['#f9c74f', '#f94144', '#f6f6f6', '#386641', '#577590'],
  },
  {
    id: 'hes-gone',
    name: 'He\'s Gone',
    colors: ['#6b2737', '#a44a3f', '#d4a373', '#f2e8cf', '#386641'],
  },
  {
    id: 'friend-of-the-devil',
    name: 'Friend of the Devil',
    colors: ['#8f4f2a', '#d98324', '#f2e8cf', '#6a994e', '#386641'],
  },
  {
    id: 'china-cat-sunflower',
    name: 'China Cat Sunflower',
    colors: ['#e40063', '#8338ec', '#3a86ff', '#fb5607', '#ffbe0b'],
  },
  {
    id: 'let-it-grow',
    name: 'Let It Grow',
    colors: ['#2a9d8f', '#e9c46a', '#264653', '#f4a261', '#e76f51'],
  },
];

export const DEFAULT_THEME_ID = 'shakedown-street';

export function getTheme(id) {
  return (
    THEMES.find((theme) => theme.id === id) ??
    THEMES.find((theme) => theme.id === DEFAULT_THEME_ID) ??
    THEMES[0]
  );
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function rgb(hex) {
  const match = String(hex).match(/^#([0-9a-f]{6})$/i);
  if (!match) return [0, 0, 0];
  const value = match[1];
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function mixHex(source, target, targetWeight) {
  const [red, green, blue] = rgb(source);
  const [targetRed, targetGreen, targetBlue] = rgb(target);
  const weight = Math.min(Math.max(targetWeight, 0), 1);
  const mix = (first, second) => Math.round(first * (1 - weight) + second * weight);
  return `#${[mix(red, targetRed), mix(green, targetGreen), mix(blue, targetBlue)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function luminance(hex) {
  const [red, green, blue] = rgb(hex);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(first, second) {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

/** A deeper version of the primary color for buttons and solid accents. */
export function themeActionColor(colors) {
  return mixHex(colors[0], '#04201c', 0.24);
}

/** The page background, matching --bg in style.css (7% theme-1 over #080a12). */
export function themeBackground(colors) {
  return mixHex(colors[0], '#080a12', 0.93);
}

/**
 * Pick the text color with better contrast against the surface it is painted on.
 * `--accent-text` only ever sits on `--theme-1` (buttons, chips, selection), so the
 * choice is measured against colors[0] rather than the darker action color, which no
 * stylesheet consumes. The dark option matches the static fallback in style.css.
 */
export function chooseAccentText(colors) {
  const surface = colors[0];
  const dark = '#06201a';
  const light = '#ffffff';
  return contrast(light, surface) > contrast(dark, surface) ? light : dark;
}

/* ------------------------------------------------------------- readable inks */

/** The dark panels ink text lands on (style.css --bg-soft and --surface). */
const INK_PANELS = ['#111521', '#151a28'];
/** AA for the small type these inks carry: 0.58rem source tags, 0.78rem counts. */
const INK_MIN_CONTRAST = 4.5;
/** Weight of the panel when a card is tinted with the palette color (color-mix 20%). */
const INK_PANEL_WEIGHT = 0.8;

function rgbToHsl(hex) {
  const [red, green, blue] = rgb(hex).map((value) => value / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (!delta) return [0, 0, lightness];

  let hue;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;

  return [
    hue < 0 ? hue + 360 : hue,
    delta / (1 - Math.abs(2 * lightness - 1)),
    lightness,
  ];
}

function hslToHex(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;

  let rgbChannels;
  if (hue < 60) rgbChannels = [chroma, secondary, 0];
  else if (hue < 120) rgbChannels = [secondary, chroma, 0];
  else if (hue < 180) rgbChannels = [0, chroma, secondary];
  else if (hue < 240) rgbChannels = [0, secondary, chroma];
  else if (hue < 300) rgbChannels = [secondary, 0, chroma];
  else rgbChannels = [chroma, 0, secondary];

  return `#${rgbChannels
    .map((value) => Math.min(255, Math.max(0, Math.round((value + match) * 255))))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * The palettes double as text inks (--ink-* in style.css), and several colors are
 * far too dark to read as small type on the dark stage — Rhythm & Blues' navy sits
 * at 1.03:1. Lift lightness, keeping hue and saturation, until the color clears AA
 * on every panel it can land on, including cards tinted with that same color.
 */
export function readableInk(color) {
  const panels = [
    ...INK_PANELS,
    ...INK_PANELS.map((panel) => mixHex(color, panel, INK_PANEL_WEIGHT)),
  ];
  const floor = (candidate) =>
    Math.min(...panels.map((panel) => contrast(candidate, panel)));

  if (floor(color) >= INK_MIN_CONTRAST) return color;

  const [hue, saturation, lightness] = rgbToHsl(color);
  let candidate = color;
  for (let step = 1; step <= 100; step += 1) {
    candidate = hslToHex(hue, saturation, Math.min(1, lightness + step * 0.01));
    if (floor(candidate) >= INK_MIN_CONTRAST) break;
  }
  return candidate;
}

export function themeInks(colors) {
  return colors.map(readableInk);
}
