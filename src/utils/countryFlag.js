/** @fileoverview Converts an ISO 3166-1 alpha-2 country code into a flag marker for chat text.
 *
 * Regional-indicator emoji (🇺🇸) render as flag pictures on macOS/iOS/Android, but
 * Windows' system emoji font has no flag glyphs and falls back to showing the raw
 * letters — so we emit a `[[FLAG:XX]]` token here instead and let the chat renderer
 * swap it for a real flag image (see Chat.svelte's renderSystemText/flagIconUrl).
 */

export function countryCodeToFlagToken(countryCode) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return `[[FLAG:${code}]]`;
}
