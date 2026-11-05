/**
 * UI Regression Detector - Shared helpers (no DOM / chrome.* dependencies)
 */

export function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Normalize a URL for grouping snapshots of the "same page".
 * Keeps origin + path + query string; drops hash and trailing slash.
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
  } catch (e) {
    return String(url || '');
  }
}

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]/;

/** Returns the src only if it is a base64 raster data URL, otherwise ''. */
export function safeImageSrc(src) {
  return typeof src === 'string' && IMAGE_DATA_URL.test(src) ? src : '';
}

/** Returns the URL only if it is http(s), otherwise '#'. */
export function safeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '#';
  } catch (e) {
    return '#';
  }
}
