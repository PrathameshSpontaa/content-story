// Runs before every request (Next.js 16 "proxy"). Every page needs a signed-in Clerk user;
// payment webhooks stay public because they're verified by signature instead.
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublic = createRouteMatcher(['/api/webhooks(.*)']);
const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

const requireSignIn = clerkMiddleware(async (auth, request) => {
  if (!isPublic(request)) await auth.protect();
});

export default function proxy(request, event) {
  if (clerkConfigured) return requireSignIn(request, event);
  // Without Clerk keys, local development stays open, but a deployed site refuses to serve pages
  // rather than become public by accident.
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
