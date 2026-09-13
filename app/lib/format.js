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
