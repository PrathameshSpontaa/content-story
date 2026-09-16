// Who is signed in, and their account in our database. Pages and actions use these helpers;
// nothing else talks to Clerk.
import { auth, currentUser } from '@clerk/nextjs/server';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { ensureAccount } from './accounts.js';
import { REFERRAL_COOKIE, normalizeCode } from './referrals.js';

export const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

// `next dev` only: DEV_PREVIEW_EMAIL signs requests in as that address so pages can be checked
// without a real sign-in. `next start` runs with NODE_ENV=production, where this is always off.
export function devPreviewEmail() {
  return process.env.NODE_ENV === 'development' ? (process.env.DEV_PREVIEW_EMAIL ?? '').trim() : '';
}

async function clerkUserId() {
  return clerkConfigured ? (await auth()).userId : null;
}

// The code from a /r/CODE link this browser opened, if any. Read only when an account is being
// created, which is the one moment it matters.
export async function referralCodeFromCookie() {
  try {
    return normalizeCode((await cookies()).get(REFERRAL_COOKIE)?.value) || null;
  } catch {
    return null;
  }
}

export const getSession = cache(async () => {
  const userId = await clerkUserId();
  if (userId) {
    return ensureAccount(userId, async () => {
      const user = await currentUser();
      return {
        email: user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? '',
        name: user?.fullName || user?.firstName || null,
        referralCode: await referralCodeFromCookie(),
      };
    });
  }
  const preview = devPreviewEmail();
  return preview ? ensureAccount(`dev:${preview}`, async () => ({ email: preview, name: 'Preview user', referralCode: await referralCodeFromCookie() })) : null;
});

// For public pages: decides between "Sign in" and "Open your feed" without creating an account.
export async function isSignedIn() {
  return Boolean((await clerkUserId()) || devPreviewEmail());
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  return session;
}

export async function requireAdmin() {
  const session = await requireSession();
  if (!session.isAdmin) notFound();
  return session;
}
