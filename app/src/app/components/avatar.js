// Initials on a tone picked from the name, so a creator looks the same on every page.
function initials(name) {
  const words = String(name ?? '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

const tone = (name) => [...String(name ?? '')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 8;

export default function Avatar({ name, kind = 'creator', size = 'md' }) {
  if (kind === 'community') {
    return (
      <span className={`avatar ${size} community`} aria-hidden="true">
        r/
      </span>
    );
  }
  if (kind === 'keyword') {
    return (
      <span className={`avatar ${size} keyword`} aria-hidden="true">
        #
      </span>
    );
  }
  return (
    <span className={`avatar ${size} t${tone(name)}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
