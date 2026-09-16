'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { skipOnboarding } from '../../../../lib/accounts.js';
import { rewardReferral } from '../../../../lib/referrals.js';
import { requireSession } from '../../../../lib/session.js';
import { completeOnboarding } from '../../../../lib/watchlist.js';

const list = (value) => (Array.isArray(value) ? value.slice(0, 100).map(String) : []);

// Setup done (either way) is when the friend who shared their link earns their credits.
// A problem here is logged, never shown: the person's own setup already succeeded.
async function payReferrer(workspaceId) {
  try {
    await rewardReferral(workspaceId);
  } catch (err) {
    console.error('referral reward failed:', err);
  }
}

export async function finishOnboardingAction(payload) {
  const session = await requireSession();
  try {
    await completeOnboarding(session.workspace.id, {
      useCase: String(payload?.useCase ?? ''),
      creatorIds: list(payload?.creatorIds),
      communities: list(payload?.communities),
      keywords: list(payload?.keywords),
    });
  } catch (err) {
    console.error(err);
    return { error: 'We couldn’t save your picks. Try again in a minute.' };
  }
  await payReferrer(session.workspace.id);
  revalidatePath('/', 'layout');
  redirect('/stories?welcome=1');
}

export async function skipOnboardingAction() {
  const session = await requireSession();
  await skipOnboarding(session.workspace.id);
  await payReferrer(session.workspace.id);
  revalidatePath('/', 'layout');
  redirect('/stories?tab=all');
}
