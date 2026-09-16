// Runs before every request (Next.js 16 "proxy"). App pages need a signed-in Clerk user; the
// landing page, sign-in, legal pages, referral links and payment webhooks (verified by signature)
// stay public.
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublic = createRouteMatcher(['/', '/sign-in(.*)', '/sign-up(.*)', '/terms', '/privacy', '/refunds', '/contact', '/r/(.*)', '/api/webhooks(.*)']);
const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
// See devPreviewEmail() in lib/session.js: `next dev` only.
const previewing = process.env.NODE_ENV === 'development' && Boolean(process.env.DEV_PREVIEW_EMAIL);

const requireSignIn = clerkMiddleware(
  async (auth, request) => {
    if (!isPublic(request) && !previewing) await auth.protect();
  },
  { signInUrl: '/sign-in', signUpUrl: '/sign-up' },
);

export default function proxy(request, event) {
  if (clerkConfigured) return requireSignIn(request, event);
  // Without Clerk keys, local development stays open, but a deployed site refuses to serve app
  // pages rather than become public by accident.
  if (process.env.NODE_ENV === 'production' && !isPublic(request)) {
    return new NextResponse('Sign-in is not configured for this deployment yet.', { status: 503 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next.js internals and static files unless they appear in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
