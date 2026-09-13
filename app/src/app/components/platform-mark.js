import { PLATFORM_NAMES } from '../../../lib/format.js';

const GLYPH = { x: 'X', linkedin: 'in', instagram: 'IG', tiktok: 'TT', reddit: 'r/' };

// A platform's badge, the same everywhere it appears.
export default function PlatformMark({ platform, size = 'sm' }) {
  const name = PLATFORM_NAMES[platform] ?? platform;
  return (
    <span className={`pmark ${size} p-${platform}`} title={name} role="img" aria-label={name}>
      {platform === 'youtube' ? (
        <svg viewBox="0 0 10 10" width="0.9em" height="0.9em" aria-hidden="true" focusable="false">
          <path d="M3 1.8v6.4L8.4 5z" fill="currentColor" />
        </svg>
      ) : (
        (GLYPH[platform] ?? '?')
      )}
    </span>
  );
}
