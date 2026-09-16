// Display helpers shared by pages. Dates render in India time, since India is the first market.
export const PLATFORM_NAMES = { x: 'X', youtube: 'YouTube', linkedin: 'LinkedIn', instagram: 'Instagram', tiktok: 'TikTok', reddit: 'Reddit' };

const TIME_ZONE = 'Asia/Kolkata';

export const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
export const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${Number(n) === 1 ? one : many}`;
export const truncate = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export const fmtDay = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: TIME_ZONE }).format(new Date(iso)) : '');
export const fmtTime = (iso) =>
  iso
    ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE }).format(new Date(iso))
    : 'time unknown';
export const dayRange = (a, b) => (fmtDay(a) === fmtDay(b) ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`);

// The writer sometimes leaves "[id, id]" at the end of a sentence; citations are rendered separately.
export const stripCites = (s) => String(s ?? '').replace(/\s*\[[^\]]*\]\s*$/, '');

export const HEAT_HELP =
  'Heat combines how far posts beat each creator’s usual engagement, how many independent sources and platforms covered it, how split the reactions are, and how recent it is.';

// India-time calendar day as a day number, so "yesterday" follows the reader's clock, not UTC.
const istDayNumber = (d) => {
  const [y, m, day] = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIME_ZONE }).format(d).split('-').map(Number);
  return Date.UTC(y, m - 1, day) / 86_400_000;
};

// How long ago something happened, for "Updated …" lines: "just now", "25 min ago", "3 hours ago",
// "yesterday", a weekday ("Tue") within the week, then a date ("9 Sept"). Empty when there's no date.
export function fmtAgo(date, now = new Date()) {
  if (!date) return '';
  const then = new Date(date);
  const at = new Date(now);
  if (Number.isNaN(then.getTime())) return '';
  const minutes = Math.floor((at - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const days = istDayNumber(at) - istDayNumber(then);
  const hours = Math.floor(minutes / 60);
  if (days === 0 || hours < 6) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: TIME_ZONE }).format(then);
  return fmtDay(then);
}

// A story counts as new while its first post is under a day old.
export function isNew(firstPostAt, now = new Date()) {
  if (!firstPostAt) return false;
  const age = new Date(now) - new Date(firstPostAt);
  return age >= 0 && age < 86_400_000;
}

// "18:00" in India time.
export const fmtClock = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TIME_ZONE }).format(new Date(iso)) : '');
