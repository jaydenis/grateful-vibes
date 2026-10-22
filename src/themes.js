/**
 * User-selectable color themes. Each palette is ordered:
 * primary, secondary, highlight, support, surface tint.
 */
export const THEMES = [
  {
    id: 'jewel-of-the-jungle',
    name: 'Jewel of the Jungle',
    colors: ['#ff9900', '#00cc99', '#FFD700', '#003300', '#597931'],
  },
  {
    id: 'cool-coastal-breeze',
    name: 'Cool Coastal Breeze',
    colors: ['#1E90FF','#bddbe8', '#2c8769', '#00cc00', '#6699cc',  ],
  },
  {
    id: 'vintage-vinyl',
    name: 'Vintage Vinyl',
    colors: ['#8B4513', '#D2691E', '#F5DEB3', '#FFF8DC', '#A0522D'],
  },
  {
    id: 'electric-vibes',
    name: 'Electric Vibes',
    colors: ['#FF1493', '#00FF7F', '#7B68EE', '#FF6347', '#FFD700'],
  },
  {
    id: 'mermaid-lagoon',
    name: 'Mermaid Lagoon',
    colors: ['#28bca9', '#99cccc', '#fb4673', '#61948f', '#F5F5DC'],
  },
  {
    id: 'cyberpunk-2077',
    name: 'Cyberpunk 2077',
    colors: ['#444444','#c5003c','#880425','#f3e600','#55ead4'],
  },
  {
    id: 'explosion',
    name: 'Explosion',
    colors: ['#00ff9f', '#00b8ff', '#001eff', '#bd00ff', '#d600ff'],
  },
  {
    id: 'sunset',
    name: 'Sunset',
    colors: ['#f8e602', '#4bff21', '#00f0ff', '#f4d5fd', '#772289'],
  },
  {
    id: 'retrowave',
    name: 'Retrowave',
    colors: ['#ff2a6d', '#d1f7ff', '#05d9e8', '#005678', '#01012b'],
  },
  {
    id: 'rockabilly-shades',
    name: 'Rockabilly Shades',
    colors: ['#BC2131','#000000','#FFFFFF','#71bdbd','#F3F2BF'],
  },
  {
    id: 'neon-x2',
    name: 'Neon X2',
    colors: ['#cc11f0', '#6300ff', '#ff008d', '#d14eea', '#f96363'],
  },
  {
    id: 'rock-and-roll-riot',
    name: 'Rock & Roll Riot',
    colors: ['#FF0000', '#000000', '#FFD700', '#A9A9A9', '#FFFFFF'],
  },
  {
    id: 'dance-floor',
    name: 'Dance Floor',
    colors: ['#b000ff', '#fd00ff', '#8900ff', '#ff0677', '#0051ff'],
  },
  {
    id: 'rain',
    name: 'Rain',
    colors: ['#467fa1', '#54295c', '#061f2b', '#1e0f1d', '#5e0b0b'],
  }

];

export const DEFAULT_THEME_ID = 'electric-vibes';

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

/** Pick the text color with better contrast against the theme's action color. */
export function chooseAccentText(colors) {
  const action = themeActionColor(colors);
  const dark = '#777777';
  const light = '#ffffff';
  return contrast(light, action) > contrast(dark, action) ? light : dark;
}
