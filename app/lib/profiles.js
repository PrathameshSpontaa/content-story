// Profile links and handles. No database here, so the browser recognises a pasted link as it's
// pasted and the server checks it the same way when it's saved.
import { PLATFORM_NAMES } from './format.js';

export class WatchlistError extends Error {}

export const CREATOR_PLATFORMS = ['x', 'youtube', 'linkedin', 'instagram', 'tiktok'];

// Accepts a pasted profile link or a handle and returns the stored form: '@name' (LinkedIn uses
// the profile slug), matching what the collectors already store.
export function parseHandle(platform, raw) {
  const input = String(raw ?? '').trim();
  if (!input) return null;
  const path = input.replace(/^https?:\/\//i, '').replace(/^(www\.|m\.|mobile\.)/i, '');
  const end = '(?:[/?#]|$)';
  const fail = (hint) => {
    throw new WatchlistError(`${PLATFORM_NAMES[platform]}: “${input}” doesn’t look like a profile. ${hint}`);
  };

  switch (platform) {
    case 'x': {
      const m = path.match(new RegExp(`^(?:x|twitter)\\.com/@?([A-Za-z0-9_]{1,15})${end}`, 'i')) ?? input.match(/^@?([A-Za-z0-9_]{1,15})$/);
      if (!m) fail('Use @handle or x.com/handle.');
      return { handle: `@${m[1]}`, url: `https://x.com/${m[1]}` };
    }
    case 'youtube': {
      const channel = path.match(/^youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i);
      if (channel) return { handle: channel[1], url: `https://www.youtube.com/channel/${channel[1]}` };
      const m = path.match(new RegExp(`^youtube\\.com/@([A-Za-z0-9._-]{3,30})${end}`, 'i')) ?? input.match(/^@?([A-Za-z0-9._-]{3,30})$/);
      if (!m) fail('Use @handle or youtube.com/@handle.');
      return { handle: `@${m[1]}`, url: `https://www.youtube.com/@${m[1]}` };
    }
    case 'instagram': {
      const m = path.match(new RegExp(`^instagram\\.com/([A-Za-z0-9._]{1,30})${end}`, 'i')) ?? input.match(/^@?([A-Za-z0-9._]{1,30})$/);
      if (!m || ['p', 'reel', 'reels', 'explore', 'stories'].includes(m[1].toLowerCase())) fail('Use @handle or instagram.com/handle.');
      return { handle: `@${m[1]}`, url: `https://www.instagram.com/${m[1]}/` };
    }
    case 'tiktok': {
      const m = path.match(new RegExp(`^tiktok\\.com/@([A-Za-z0-9._]{2,24})${end}`, 'i')) ?? input.match(/^@?([A-Za-z0-9._]{2,24})$/);
      if (!m) fail('Use @handle or tiktok.com/@handle.');
      return { handle: `@${m[1]}`, url: `https://www.tiktok.com/@${m[1]}` };
    }
    case 'linkedin': {
      const company = path.match(/^linkedin\.com\/company\/([A-Za-z0-9%_-]{2,100})/i);
      if (company) return { handle: `company/${company[1].toLowerCase()}`, url: `https://www.linkedin.com/company/${company[1]}/` };
      const m = path.match(/^linkedin\.com\/in\/([A-Za-z0-9%_-]{2,100})/i);
      if (!m) fail('Paste the profile link, like linkedin.com/in/name.');
      return { handle: m[1].toLowerCase(), url: `https://www.linkedin.com/in/${m[1]}/` };
    }
    default:
      return null;
  }
}

export function parseCommunity(raw) {
  const input = String(raw ?? '').trim();
  const m = input.replace(/^https?:\/\//i, '').match(/^(?:(?:www\.|old\.)?reddit\.com\/)?\/?r\/([A-Za-z0-9_]{2,21})\/?$/i) ?? input.match(/^([A-Za-z0-9_]{2,21})$/);
  if (!m) throw new WatchlistError(`“${input}” isn’t a subreddit. Use r/name or a reddit.com/r/name link.`);
  return `r/${m[1]}`;
}

// Which platform a pasted profile link belongs to. Bare handles return null.
export function detectPlatform(raw) {
  const path = String(raw ?? '').trim().replace(/^https?:\/\//i, '').replace(/^(www\.|m\.|mobile\.|old\.)/i, '').toLowerCase();
  if (/^(x|twitter)\.com\//.test(path)) return 'x';
  if (/^(youtube\.com|youtu\.be)\//.test(path)) return 'youtube';
  if (/^linkedin\.com\//.test(path)) return 'linkedin';
  if (/^instagram\.com\//.test(path)) return 'instagram';
  if (/^tiktok\.com\//.test(path)) return 'tiktok';
  if (/^reddit\.com\/r\//.test(path) || /^\/?r\/[a-z0-9_]+\/?$/.test(path)) return 'reddit';
  return null;
}

// A pasted link or @handle, as opposed to a name to search for.
export function looksLikeProfile(raw) {
  const value = String(raw ?? '').trim();
  return /^https?:\/\//i.test(value) || /^(www\.)?[a-z0-9-]+\.(com|be)\//i.test(value) || value.startsWith('@') || /^\/?r\/\w/i.test(value);
}

// "@tanmay.bhat" → "Tanmay Bhat": a starting point for the name field, always editable.
export function nameFromHandle(handle) {
  return String(handle ?? '')
    .replace(/^@|^company\//, '')
    .replace(/[._-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
