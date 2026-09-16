// A referral link: /r/CODE. Remembers the code in a cookie for REFERRAL.cookieDays, then sends
// the visitor to sign-up. Unknown codes just go to sign-up with nothing remembered.
import { NextResponse } from 'next/server';
import { REFERRAL } from '../../../../lib/pricing.js';
import { REFERRAL_COOKIE, lookupCode, normalizeCode } from '../../../../lib/referrals.js';

export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { code } = await params;
  const normalized = normalizeCode(code);
  const referrer = normalized ? await lookupCode(normalized) : null;

  // Render terminates TLS, so the request itself arrives over http; honour the forwarded scheme.
  const url = new URL(request.url);
  url.protocol = request.headers.get('x-forwarded-proto') === 'https' ? 'https:' : url.protocol;
  url.pathname = '/sign-up';
  url.search = '';

  const response = NextResponse.redirect(url, 302);
  if (referrer) {
    response.cookies.set(REFERRAL_COOKIE, normalized, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: REFERRAL.cookieDays * 86_400,
    });
  }
  return response;
}
