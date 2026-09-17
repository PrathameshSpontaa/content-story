// Which watchlist new follows go into: the one last picked on the Following page, kept in a cookie.
// Server-only. The follow code checks it still belongs to the workspace and uses the first watchlist when
// it doesn't, or when nothing was picked.
import { cookies } from 'next/headers';

const COOKIE = 'cs_watchlist';
const UUID = /^[0-9a-f-]{36}$/i;

export async function chosenWatchlistIds() {
  const value = (await cookies()).get(COOKIE)?.value ?? '';
  return UUID.test(value) ? [value] : [];
}

// Only from a server action or route handler, where cookies can be written.
export async function chooseWatchlist(watchlistId) {
  (await cookies()).set(COOKIE, String(watchlistId), { path: '/', sameSite: 'lax', httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
}
