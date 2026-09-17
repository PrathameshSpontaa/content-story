// The Apify account's usage this month against its monthly limit, for the admin panel.
// GET https://api.apify.com/v2/users/me/limits (docs.apify.com/api/v2/users-me-limits-get).
// Never throws: a missing token or a failed call comes back as { ok: false, message }.
import { loadEnv } from './env.js';

const LIMITS_URL = 'https://api.apify.com/v2/users/me/limits';
const CACHE_MS = 5 * 60_000;
// A failure is kept briefly so a down API doesn't slow every page load.
const FAILURE_CACHE_MS = 60_000;

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export async function apifyBalance({ now = Date.now() } = {}) {
  loadEnv();
  const token = (process.env.APIFY_TOKEN ?? '').trim();
  if (!token) return { ok: false, message: 'APIFY_TOKEN isn’t set, so the Apify balance can’t be shown.' };

  const cached = globalThis.__contentStoryApifyBalance;
  if (cached && now - cached.at < (cached.value.ok ? CACHE_MS : FAILURE_CACHE_MS)) return cached.value;

  let value;
  try {
    const res = await fetch(LIMITS_URL, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
    // Only the status is shown: the body isn't needed and nothing here should echo the request.
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'Apify didn’t accept APIFY_TOKEN' : `Apify answered ${res.status}`);
    const { data } = await res.json();
    const usageUsd = num(data?.current?.monthlyUsageUsd);
    const limitUsd = num(data?.limits?.maxMonthlyUsageUsd);
    if (usageUsd == null || limitUsd == null) throw new Error('Apify’s answer had no usage or limit');
    value = {
      ok: true,
      usageUsd,
      limitUsd,
      leftUsd: Math.max(0, limitUsd - usageUsd),
      pct: limitUsd ? Math.round((usageUsd / limitUsd) * 100) : null,
      cycleStart: data?.monthlyUsageCycle?.startAt ?? null,
      cycleEnd: data?.monthlyUsageCycle?.endAt ?? null,
      checkedAt: new Date(now).toISOString(),
    };
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? 'Apify didn’t answer in time' : String(err?.message ?? 'the request failed').replaceAll(token, '…');
    value = { ok: false, message: `Couldn’t read the Apify balance: ${reason}. Try again in a minute.` };
  }
  globalThis.__contentStoryApifyBalance = { at: now, value };
  return value;
}
