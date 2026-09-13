// Pricing rules the browser needs too (forms show a quote before submitting). No database here:
// per-action credit prices live in price_list and are read on the server.
export const PLATFORMS = ['x', 'youtube', 'linkedin', 'instagram', 'tiktok', 'reddit'];

// Every new workspace starts here until it subscribes.
export const TRIAL = { credits: 1000, maxSources: 10, maxKeywords: 3, seats: 1 };

export const REPORT_MAX_DAYS = 7;
export const REPORT_LOOKBACK_DAYS = 30;
export const TOPUP_PACKS = [1000, 5000, 15000];

// One topic: 300 credits for up to 3 platforms and 3 days, then 80 per extra platform and
// 50 per extra day, capped at 800 (the 300–800 range in LAUNCH_PLAN.md).
export function quoteReport({ platforms, days }) {
  const p = Math.max(1, Number(platforms) || 1);
  const d = Math.max(1, Number(days) || 1);
  return Math.min(800, 300 + 80 * Math.max(0, p - 3) + 50 * Math.max(0, d - 3));
}

// Inclusive day count between two YYYY-MM-DD dates.
export const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

export const fmtINR = (paise) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(paise || 0) / 100);
