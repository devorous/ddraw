export const TEXT_FONT_OPTIONS = [
  {
    label: 'Newsreader',
    family: 'Newsreader, serif',
    googleFamily: 'Newsreader:opsz@6..72',
    pickerFontSize: 15,
    appliedSizeMultiplier: 0,
    appliedOffset: -1
  },
  {
    label: 'Nunito',
    family: 'Nunito, sans-serif',
    googleFamily: 'Nunito:ital,wght@0,200..1000;1,200..1000',
    pickerFontSize: 15,
    appliedSizeMultiplier: 0.25,
    appliedOffset: 0
  },
  {
    label: 'Silkscreen',
    family: 'Silkscreen, cursive',
    googleFamily: 'Silkscreen:wght@400;700',
    pickerFontSize: 14,
    appliedSizeMultiplier: 0.25,
    appliedOffset: 0
  },
  {
    label: 'Tangerine',
    family: 'Tangerine, cursive',
    googleFamily: 'Tangerine:wght@400;700',
    pickerFontSize: 20,
    appliedSizeMultiplier: 0,
    appliedOffset: 0
  },
  {
    label: 'Permanent Marker',
    family: '"Permanent Marker", cursive',
    googleFamily: 'Permanent Marker',
    pickerFontSize: 15,
    appliedSizeMultiplier: 0.35,
    appliedOffset: 0,
    letterSpacing: '0.04em'
  },
  {
    label: 'Righteous',
    family: 'Righteous, sans-serif',
    googleFamily: 'Righteous',
    pickerFontSize: 15,
    appliedSizeMultiplier: 0.25,
    appliedOffset: 0
  },
  {
    label: 'Fredoka',
    family: 'Fredoka, sans-serif',
    googleFamily: 'Fredoka:wght@300..700',
    pickerFontSize: 15,
    appliedSizeMultiplier: 0.25,
    appliedOffset: 0
  },
  {
    label: 'Lobster',
    family: 'Lobster, cursive',
    googleFamily: 'Lobster',
    pickerFontSize: 17,
    appliedSizeMultiplier: 0.2,
    appliedOffset: 0,
    letterSpacing: '0.025em'
  },
  {
    label: 'Space Mono',
    family: '"Space Mono", monospace',
    googleFamily: 'Space Mono:wght@400;700',
    pickerFontSize: 14,
    appliedSizeMultiplier: 0.35,
    appliedOffset: 0
  },
  {
    label: 'Great Vibes',
    family: '"Great Vibes", cursive',
    googleFamily: 'Great Vibes',
    pickerFontSize: 21,
    appliedSizeMultiplier: 0.15,
    appliedOffset: 0
  },
  {
    label: 'Baloo 2',
    family: '"Baloo 2", sans-serif',
    googleFamily: 'Baloo 2:wght@400..800',
    pickerFontSize: 15,
    appliedSizeMultiplier: 0.35,
    appliedOffset: 0
  },
  {
    label: 'Patrick Hand',
    family: '"Patrick Hand", cursive',
    googleFamily: 'Patrick Hand',
    pickerFontSize: 16,
    appliedSizeMultiplier: 0.25,
    appliedOffset: 0
  }
];

export const DEFAULT_TEXT_FONT = 'Nunito, sans-serif';

const TEXT_FONT_FAMILIES = new Set(TEXT_FONT_OPTIONS.map(font => font.family));
const TEXT_FONT_DEFAULTS = new Map(TEXT_FONT_OPTIONS.map(font => [
  font.family,
  {
    textPositionMultiplier: font.appliedSizeMultiplier ?? 0,
    textPositionOffset: font.appliedOffset ?? 0
  }
]));
const TEXT_FONT_LETTER_SPACING = new Map(TEXT_FONT_OPTIONS.map(font => [
  font.family,
  font.letterSpacing || 'normal'
]));

export function normalizeTextFont(font) {
  return TEXT_FONT_FAMILIES.has(font) ? font : DEFAULT_TEXT_FONT;
}

/**
 * Font stack actually applied to `ctx.font` / CSS `font-family` wherever a text
 * record is measured, painted, or previewed. Appends the self-hosted Fluent
 * Emoji Color webfont (see public/fonts/fluentmoji-color) as a fallback so any
 * emoji typed into the text tool rasterizes identically for every viewer,
 * regardless of their OS's native emoji font. Only affects code points in the
 * font's unicode-range — normal glyphs still come from the chosen text font.
 */
export function getTextFontStack(font) {
  return `${normalizeTextFont(font)}, 'Fluent Emoji Color'`;
}

export function getTextFontDefaults(font) {
  return TEXT_FONT_DEFAULTS.get(normalizeTextFont(font)) || {
    textPositionMultiplier: 0,
    textPositionOffset: 0
  };
}

/**
 * Per-font letter-spacing (CSS length string, e.g. '0.04em') applied wherever
 * text is measured or painted, so glyphs on fonts with tight/overlapping
 * default kerning (marker/script faces) get consistent breathing room across
 * the canvas render, the SVG overlay, and the live DOM typing preview.
 */
export function getTextFontLetterSpacing(font) {
  return TEXT_FONT_LETTER_SPACING.get(normalizeTextFont(font)) || 'normal';
}

export function ensureTextFontsLoaded(doc = document) {
  if (!doc?.head) return;

  const preconnectGoogle = 'https://fonts.googleapis.com';
  const preconnectStatic = 'https://fonts.gstatic.com';

  if (!doc.head.querySelector(`link[href="${preconnectGoogle}"]`)) {
    const link = doc.createElement('link');
    link.rel = 'preconnect';
    link.href = preconnectGoogle;
    doc.head.appendChild(link);
  }

  if (!doc.head.querySelector(`link[href="${preconnectStatic}"]`)) {
    const link = doc.createElement('link');
    link.rel = 'preconnect';
    link.href = preconnectStatic;
    link.crossOrigin = 'anonymous';
    doc.head.appendChild(link);
  }

  const googleFamilies = TEXT_FONT_OPTIONS
    .map(font => font.googleFamily)
    .filter(Boolean);

  if (googleFamilies.length === 0) return;

  const href = `https://fonts.googleapis.com/css2?${googleFamilies
    .map(family => `family=${encodeURIComponent(family)}`)
    .join('&')}&display=swap`;

  if (!doc.head.querySelector(`link[data-text-fonts="true"][href="${href}"]`)) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.textFonts = 'true';
    doc.head.appendChild(link);
  }
}

export function loadTextFont(font, doc = document) {
  ensureTextFontsLoaded(doc);
  const normalizedFont = normalizeTextFont(font);
  return Promise.resolve(normalizedFont);
}
